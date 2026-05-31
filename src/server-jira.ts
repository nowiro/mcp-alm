#!/usr/bin/env node
/**
 * mcp-jira — read tools (optional write tools gated by `MCP_WRITE_ENABLED`).
 *
 * Extraction pipeline:
 *   - `field-registry` resolves `customfield_NNNNN` → readable name on first call.
 *   - `adf` renders ADF descriptions / comments to Markdown.
 *   - `extract` walks paged search results under a token budget.
 *   - `jira-reshape` projects out the noise (icons, _links, etc.) and keeps
 *     the human-relevant fields + every populated custom field.
 *
 * Search endpoint: uses `/rest/api/3/search/jql` (cursor pagination via
 * `nextPageToken`) — the legacy offset `/search` was removed on 2025-05-01.
 *
 * Token-cost defaults (PLAN.md — usage-based billing, 2026-06-01):
 *   - `budgetTokens` defaults to 2 500 in mcp-alm (callers can override up to 80 000).
 *   - `fields` projection is the same on `get_issue` and `search_issues`, so
 *     a Copilot agent that asked for the cheap shape on a search keeps it on
 *     the per-issue fetch.
 */
import { z } from 'zod';

import { loadJiraAuth } from './shared/auth.js';
import { BudgetTracker } from './shared/budget.js';
import { ValidationError } from './shared/errors.js';
import { extract } from './shared/extract.js';
import { createJiraFieldRegistry } from './shared/field-registry.js';
import { createNamedHttpClient } from './shared/http-client.js';
import { reshapeJiraIssue, type CanonicalIssue } from './shared/jira-reshape.js';
import { reshapeBoard, reshapeBoardConfig, reshapeSprint } from './shared/jira-agile-reshape.js';
import { compileJqlFilter, JqlFilterSchema } from './shared/jql-builder.js';
import {
  bootMcpServerIfEnabled,
  defineTool,
  markTruncated,
  usageHistoryTool,
  type ToolDefinition,
} from './shared/mcp-server.js';
import { definePrompt, type PromptDefinition } from './shared/prompt.js';
import { defineMarkdownResource, type ResourceDefinition } from './shared/resource.js';
import { jiraJqlCursorAdapter, jiraOffsetAdapter } from './shared/pagination.js';
import { assertWriteAllowed, isWriteEnabled } from './shared/write-guard.js';
import { adfToMarkdown, type AdfNode } from './shared/adf.js';

const SERVER_NAME = 'mcp-jira';

/** Default field projection — covers what 95 % of read tools care about. */
const DEFAULT_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'labels', 'updated', '*navigable'];
/** Lowered default per PLAN.md AC1 — overridable via the tool param. */
const DEFAULT_BUDGET_TOKENS = 2500;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

const IssueKey = z.string().regex(ISSUE_KEY_RE);
const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9]+$/);

const GetIssueInput = z.object({
  key: IssueKey,
  fields: z.array(z.string().min(1)).optional(),
  include_changelog: z.boolean().default(false),
  include_comments: z.boolean().default(false),
  include_worklog: z.boolean().default(false),
  include_issuelinks: z.boolean().default(false),
  include_subtasks: z.boolean().default(false),
  include_attachments: z.boolean().default(false),
  include_properties: z.boolean().default(false),
});
const SearchInput = z.object({
  jql: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(25),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
  fields: z.array(z.string().min(1)).optional(),
});
const ListProjectsInput = z.object({});
const ListTransitionsInput = z.object({ key: IssueKey });
const GetCommentsInput = z.object({
  key: IssueKey,
  limit: z.number().int().min(1).max(100).default(25),
});
const GetWorklogsInput = z.object({
  key: IssueKey,
  limit: z.number().int().min(1).max(100).default(50),
});
const GetChangelogInput = z.object({
  key: IssueKey,
  limit: z.number().int().min(1).max(100).default(50),
});
const ApproximateCountInput = z.object({ jql: z.string().min(1) });
const HealthInput = z.object({});
const JqlBuilderInput = z.object({ filter: JqlFilterSchema });

const ListBoardsInput = z.object({
  /** Scope to one project — accepts a key (`PROJ`) or a numeric project id. */
  projectKeyOrId: z.string().min(1).optional(),
  type: z.enum(['scrum', 'kanban', 'simple']).optional(),
  /** Case-insensitive substring match on the board name (upstream filter). */
  name: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
const ListSprintsInput = z.object({
  boardId: z.number().int().positive(),
  /**
   * Sprint states to include. Defaults to active + future so a board with
   * years of closed sprints does not blow the token budget — pass `closed`
   * explicitly for history.
   */
  state: z
    .array(z.enum(['active', 'future', 'closed']))
    .min(1)
    .max(3)
    .default(['active', 'future']),
  limit: z.number().int().min(1).max(50).default(50),
});
const GetSprintInput = z.object({ sprintId: z.number().int().positive() });
const GetSprintIssuesInput = z.object({
  sprintId: z.number().int().positive(),
  /** Optional JQL to narrow within the sprint (e.g. `assignee = currentUser()`). */
  jql: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
  fields: z.array(z.string().min(1)).optional(),
});
const GetBoardConfigInput = z.object({ boardId: z.number().int().positive() });

const CreateIssueInput = z.object({
  projectKey: ProjectKey,
  summary: z.string().min(1).max(255),
  issueType: z.string().default('Task'),
  description: z.string().optional(),
  /** When true, return the constructed request body without hitting the upstream. */
  dryRun: z.boolean().default(false),
});
const TransitionIssueInput = z.object({
  key: IssueKey,
  transitionId: z.string().min(1),
  dryRun: z.boolean().default(false),
});
const AddCommentInput = z.object({
  key: IssueKey,
  body: z.string().min(1).max(32_768),
  dryRun: z.boolean().default(false),
});
const AddWorklogInput = z.object({
  key: IssueKey,
  /** Jira format: "1h 30m" / "2d" / "45m". Accepts seconds via timeSpentSeconds alternative. */
  timeSpent: z
    .string()
    .regex(/^[0-9 dhms]+$/)
    .optional(),
  timeSpentSeconds: z.number().int().min(60).optional(),
  /** ISO 8601 (UTC) start time; defaults to now in upstream. */
  started: z.string().datetime().optional(),
  comment: z.string().max(32_768).optional(),
  dryRun: z.boolean().default(false),
});
const LinkIssuesInput = z.object({
  inwardKey: IssueKey,
  outwardKey: IssueKey,
  /** Link type name (e.g. "Blocks", "Relates", "Duplicates") — must exist in /rest/api/3/issueLinkType. */
  linkType: z.string().min(1),
  comment: z.string().max(32_768).optional(),
  dryRun: z.boolean().default(false),
});

/**
 * AC51 — bulk Jira ops.
 * `bulk_get_issues` używa JQL `key in (KEY-1, KEY-2, …)` — 1 RTT zamiast N.
 * `bulk_create_issues` używa `/rest/api/3/issue/bulk` (max 50 per call).
 */
const BulkGetIssuesInput = z.object({
  keys: z.array(IssueKey).min(1).max(100),
  fields: z.array(z.string().min(1)).optional(),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
});
const BulkCreateIssuesInput = z.object({
  issues: z
    .array(
      z.object({
        projectKey: ProjectKey,
        summary: z.string().min(1).max(255),
        issueType: z.string().default('Task'),
        description: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
  dryRun: z.boolean().default(false),
});

const auth = loadJiraAuth();
const http = createNamedHttpClient(SERVER_NAME, auth);
const registry = createJiraFieldRegistry(http);

interface JiraIssueRaw {
  readonly id: string;
  readonly key: string;
  readonly self?: string;
  readonly fields?: Record<string, unknown>;
  readonly changelog?: { readonly histories?: readonly unknown[] };
  readonly renderedFields?: Record<string, unknown>;
}

interface JqlSearchResponse {
  readonly issues: readonly JiraIssueRaw[];
  readonly nextPageToken?: string;
  readonly isLast?: boolean;
}

/** Jira Agile (`/rest/agile/1.0/`) paged envelope — offset-based, `values` + `isLast`. */
interface AgileListResponse<T> {
  readonly values?: readonly T[];
  readonly isLast?: boolean;
}

/** Agile `/sprint/{id}/issue` envelope — offset-based, `issues` + `total`. */
interface AgileIssueSearchResponse {
  readonly issues: readonly JiraIssueRaw[];
  readonly total?: number;
}

const tools: ToolDefinition[] = [
  defineTool({
    name: 'jira.get_issue',
    description:
      'Fetch one Jira issue by key. Returns canonical shape with readable custom fields and Markdown description. Optional opt-in flags: include_changelog (history), include_comments, include_worklog, include_issuelinks, include_subtasks, include_attachments, include_properties.',
    inputSchema: GetIssueInput,
    async handle(input, ctx) {
      const fieldList = buildFieldList(input);
      const expand = buildExpandList(input);
      const raw = await http.request<JiraIssueRaw>({
        path: `/rest/api/3/issue/${input.key}`,
        query: {
          fields: fieldList,
          ...(expand ? { expand } : {}),
        },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const base = reshapeJiraIssue(raw, registry);
      const extras = await collectExtras(input, raw, ctx);
      return Object.keys(extras).length > 0 ? { ...base, ...extras } : base;
    },
  }),
  defineTool({
    name: 'jira.search_issues',
    description:
      'JQL search via /rest/api/3/search/jql with budget-aware cursor pagination (default 2,500 tokens, max 80,000). Pass `fields` to narrow upstream projection. Returns `{ items, truncated, next? }` — call `jira.approximate_count` for total.',
    inputSchema: SearchInput,
    async handle({ jql, limit, budgetTokens, fields }, ctx) {
      const budget = new BudgetTracker(budgetTokens);
      const projection = (fields ?? DEFAULT_FIELDS).join(',');
      const fetchPage = jiraJqlCursorAdapter<CanonicalIssue, JqlSearchResponse>(
        async ({ nextPageToken, maxResults }) =>
          http.request<JqlSearchResponse>({
            path: '/rest/api/3/search/jql',
            query: {
              jql,
              maxResults,
              fields: projection,
              ...(nextPageToken ? { nextPageToken } : {}),
            },
            correlationId: ctx.correlationId,
            tool: ctx.tool,
          }),
        (raw) => raw.issues.map((i) => reshapeJiraIssue(i, registry)),
        Math.min(50, limit),
      );
      const result = await extract<CanonicalIssue, CanonicalIssue>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: limit,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'jira.approximate_count',
    description:
      'Approximate total result count for a JQL — the new search/jql endpoint no longer returns `total`. Use this for paging UI / "how many issues match" questions.',
    inputSchema: ApproximateCountInput,
    async handle({ jql }, ctx) {
      return http.request({
        path: '/rest/api/3/search/approximate-count',
        method: 'POST',
        body: { jql },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'jira.list_projects',
    description: 'List Jira projects the user can browse.',
    inputSchema: ListProjectsInput,
    async handle(_input, ctx) {
      return http.request({
        path: '/rest/api/3/project/search',
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'jira.list_boards',
    description:
      'List Jira Agile boards (Scrum/Kanban) the token can see. Filter by `projectKeyOrId`, `type` (scrum|kanban|simple), or `name` substring. Returns canonical `{ id, name, type, projectKey?, projectName? }` plus `isLast`. Feed a board id into `jira.list_sprints`.',
    inputSchema: ListBoardsInput,
    async handle({ projectKeyOrId, type, name, limit }, ctx) {
      const raw = await http.request<AgileListResponse<Parameters<typeof reshapeBoard>[0]>>({
        path: '/rest/agile/1.0/board',
        query: {
          maxResults: limit,
          ...(projectKeyOrId ? { projectKeyOrId } : {}),
          ...(type ? { type } : {}),
          ...(name ? { name } : {}),
        },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { boards: (raw.values ?? []).map((b) => reshapeBoard(b)), isLast: raw.isLast ?? true };
    },
  }),
  defineTool({
    name: 'jira.list_sprints',
    description:
      'List sprints on a board. `state` defaults to ["active","future"] — closed sprints are excluded unless requested (a board can carry years of them). Returns canonical `{ id, name, state, startDate?, endDate?, completeDate?, goal?, boardId? }` plus `isLast`. Get the board id from `jira.list_boards`.',
    inputSchema: ListSprintsInput,
    async handle({ boardId, state, limit }, ctx) {
      const raw = await http.request<AgileListResponse<Parameters<typeof reshapeSprint>[0]>>({
        path: `/rest/agile/1.0/board/${boardId}/sprint`,
        query: { maxResults: limit, state: state.join(',') },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { sprints: (raw.values ?? []).map((s) => reshapeSprint(s)), isLast: raw.isLast ?? true };
    },
  }),
  defineTool({
    name: 'jira.get_sprint',
    description:
      'Fetch one sprint by id — canonical `{ id, name, state, startDate?, endDate?, completeDate?, goal?, boardId? }`. Pairs with the `jira.sprint-summary` prompt for velocity reporting.',
    inputSchema: GetSprintInput,
    async handle({ sprintId }, ctx) {
      const raw = await http.request<Parameters<typeof reshapeSprint>[0]>({
        path: `/rest/agile/1.0/sprint/${sprintId}`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return reshapeSprint(raw);
    },
  }),
  defineTool({
    name: 'jira.get_sprint_issues',
    description:
      'List issues in a sprint via /rest/agile/1.0/sprint/{id}/issue with budget-aware offset pagination (default 2,500 tokens, max 80,000). Optional `jql` narrows within the sprint; `fields` narrows the upstream projection. Returns `{ items, truncated, next? }` — canonical issue shapes (readable custom fields + Markdown description), so velocity / status rollups read straight off the result.',
    inputSchema: GetSprintIssuesInput,
    async handle({ sprintId, jql, limit, budgetTokens, fields }, ctx) {
      const budget = new BudgetTracker(budgetTokens);
      const projection = (fields ?? DEFAULT_FIELDS).join(',');
      const fetchPage = jiraOffsetAdapter<CanonicalIssue, AgileIssueSearchResponse>(
        async ({ startAt, maxResults }) =>
          http.request<AgileIssueSearchResponse>({
            path: `/rest/agile/1.0/sprint/${sprintId}/issue`,
            query: {
              startAt,
              maxResults,
              fields: projection,
              ...(jql ? { jql } : {}),
            },
            correlationId: ctx.correlationId,
            tool: ctx.tool,
          }),
        (raw) => raw.issues.map((i) => reshapeJiraIssue(i, registry)),
        (raw) => raw.total,
        Math.min(50, limit),
      );
      const result = await extract<CanonicalIssue, CanonicalIssue>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: limit,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'jira.get_board_config',
    description:
      'Board configuration — columns (name + mapped status ids) and the estimation field (e.g. `customfield_10016` "Story Points"). Feed `estimationField.id` into `fields` on `jira.get_sprint_issues` / `jira.search_issues` to read story points without guessing the custom-field id.',
    inputSchema: GetBoardConfigInput,
    async handle({ boardId }, ctx) {
      const raw = await http.request<Parameters<typeof reshapeBoardConfig>[0]>({
        path: `/rest/agile/1.0/board/${boardId}/configuration`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return reshapeBoardConfig(raw);
    },
  }),
  defineTool({
    name: 'jira.health',
    description: 'Smoke-test the upstream + token: GET /rest/api/3/myself. Returns { ok, accountId, durationMs }.',
    inputSchema: HealthInput,
    async handle(_input, ctx) {
      const start = Date.now();
      const raw = await http.request<{ accountId?: string }>({
        path: '/rest/api/3/myself',
        cache: false,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { ok: true, accountId: raw.accountId ?? '', durationMs: Date.now() - start };
    },
  }),
  defineTool({
    name: 'jira.list_transitions',
    description:
      'List available workflow transitions for an issue. Needed before calling jira.transition_issue (each has an id and target status).',
    inputSchema: ListTransitionsInput,
    async handle({ key }, ctx) {
      return http.request({
        path: `/rest/api/3/issue/${key}/transitions`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'jira.get_comments',
    description: 'Fetch comments for an issue. Bodies are normalised from ADF to Markdown.',
    inputSchema: GetCommentsInput,
    async handle({ key, limit }, ctx) {
      const raw = await http.request<{ comments?: readonly RawComment[] }>({
        path: `/rest/api/3/issue/${key}/comment`,
        query: { maxResults: limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { comments: (raw.comments ?? []).map((c) => normaliseComment(c)) };
    },
  }),
  defineTool({
    name: 'jira.get_worklogs',
    description: 'Fetch worklogs for an issue (start, time spent, author, comment).',
    inputSchema: GetWorklogsInput,
    async handle({ key, limit }, ctx) {
      const raw = await http.request<{ worklogs?: readonly RawWorklog[] }>({
        path: `/rest/api/3/issue/${key}/worklog`,
        query: { maxResults: limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { worklogs: (raw.worklogs ?? []).map((w) => normaliseWorklog(w)) };
    },
  }),
  defineTool({
    name: 'jira.get_changelog',
    description: 'Fetch the change history of an issue (status moves, field edits).',
    inputSchema: GetChangelogInput,
    async handle({ key, limit }, ctx) {
      const raw = await http.request<{ values?: readonly RawChangelog[] }>({
        path: `/rest/api/3/issue/${key}/changelog`,
        query: { maxResults: limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { changelog: (raw.values ?? []).map((v) => normaliseChangelogEntry(v)) };
    },
  }),
  usageHistoryTool(SERVER_NAME),
  defineTool({
    name: 'jira.jql_builder',
    description:
      'Compose a type-safe JQL string from a structured filter tree (pure function — no upstream call). Accepts a discriminated-union `filter` with kinds: project, status, assignee, updated_since, and, or, not, raw. Returns `{ jql, valid, errors }`. Values are quote-escaped; `assignee.user` of `currentUser()` is preserved as a function call. Use `raw` for edge-case JQL not yet covered by a structured kind (balanced-quote / balanced-paren lint runs on raw fragments). Max nesting depth is 10.',
    inputSchema: JqlBuilderInput,
    async handle({ filter }) {
      return compileJqlFilter(filter);
    },
  }),
  defineTool({
    name: 'jira.bulk_get_issues',
    description:
      'AC51: Fetch multiple Jira issues in 1 RTT using JQL `key in (KEY-1, KEY-2, …)`. Up to 100 keys per call. ~10× faster + ~3× cheaper in tokens vs N individual `jira.get_issue` calls (no per-request auth overhead).',
    inputSchema: BulkGetIssuesInput,
    async handle({ keys, fields, budgetTokens }, ctx) {
      const jql = `key in (${keys.join(', ')})`;
      const projection = (fields ?? DEFAULT_FIELDS).join(',');
      const budget = new BudgetTracker(budgetTokens);
      const fetchPage = jiraJqlCursorAdapter<CanonicalIssue, JqlSearchResponse>(
        async ({ nextPageToken, maxResults }) =>
          http.request<JqlSearchResponse>({
            path: '/rest/api/3/search/jql',
            query: {
              jql,
              maxResults,
              fields: projection,
              ...(nextPageToken ? { nextPageToken } : {}),
            },
            correlationId: ctx.correlationId,
            tool: ctx.tool,
          }),
        (raw) => raw.issues.map((i) => reshapeJiraIssue(i, registry)),
        Math.min(50, keys.length),
      );
      const result = await extract<CanonicalIssue, CanonicalIssue>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: keys.length,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
];

if (isWriteEnabled()) {
  tools.push(
    defineTool({
      name: 'jira.create_issue',
      description:
        'Create a Jira issue (write — requires MCP_WRITE_ALLOWLIST entry). Pass `dryRun: true` to see the constructed request body without hitting upstream.',
      inputSchema: CreateIssueInput,
      async handle({ projectKey, summary, issueType, description, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const body = {
          fields: {
            project: { key: projectKey },
            summary,
            issuetype: { name: issueType },
            ...(description
              ? {
                  description: {
                    type: 'doc',
                    version: 1,
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
                  },
                }
              : {}),
          },
        };
        if (dryRun) return { dryRun: true, method: 'POST', path: '/rest/api/3/issue', body };
        return http.request({
          method: 'POST',
          path: '/rest/api/3/issue',
          body,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
    defineTool({
      name: 'jira.transition_issue',
      description:
        'Move an issue along a workflow transition (write — requires MCP_WRITE_ALLOWLIST entry). `dryRun: true` echoes the request.',
      inputSchema: TransitionIssueInput,
      async handle({ key, transitionId, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = `/rest/api/3/issue/${key}/transitions`;
        const body = { transition: { id: transitionId } };
        if (dryRun) return { dryRun: true, method: 'POST', path, body };
        return http.request({
          method: 'POST',
          path,
          body,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
    defineTool({
      name: 'jira.add_comment',
      description:
        'Add a comment to an issue (write — requires MCP_WRITE_ALLOWLIST entry). `dryRun: true` echoes the request.',
      inputSchema: AddCommentInput,
      async handle({ key, body: commentBody, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = `/rest/api/3/issue/${key}/comment`;
        const body = {
          body: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: commentBody }] }],
          },
        };
        if (dryRun) return { dryRun: true, method: 'POST', path, body };
        return http.request({
          method: 'POST',
          path,
          body,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
    defineTool({
      name: 'jira.add_worklog',
      description:
        'Log work on an issue (write — requires MCP_WRITE_ALLOWLIST entry). Provide either `timeSpent` ("1h 30m") OR `timeSpentSeconds`. Optional ISO `started`, ADF-wrapped `comment`.',
      inputSchema: AddWorklogInput,
      async handle({ key, timeSpent, timeSpentSeconds, started, comment, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        if (!timeSpent && timeSpentSeconds === undefined) {
          throw new ValidationError('provide either timeSpent or timeSpentSeconds', 'jira.add_worklog');
        }
        const path = `/rest/api/3/issue/${key}/worklog`;
        const body = {
          ...(timeSpent ? { timeSpent } : {}),
          ...(timeSpentSeconds === undefined ? {} : { timeSpentSeconds }),
          ...(started ? { started: jiraStarted(started) } : {}),
          ...(comment
            ? {
                comment: {
                  type: 'doc',
                  version: 1,
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }],
                },
              }
            : {}),
        };
        if (dryRun) return { dryRun: true, method: 'POST', path, body };
        return http.request({
          method: 'POST',
          path,
          body,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
    defineTool({
      name: 'jira.link_issues',
      description:
        'Create an issue link between two issues (write — requires MCP_WRITE_ALLOWLIST entry). `linkType` must be a name from /rest/api/3/issueLinkType (e.g. "Blocks", "Relates").',
      inputSchema: LinkIssuesInput,
      async handle({ inwardKey, outwardKey, linkType, comment, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = '/rest/api/3/issueLink';
        const body = {
          type: { name: linkType },
          inwardIssue: { key: inwardKey },
          outwardIssue: { key: outwardKey },
          ...(comment
            ? {
                comment: {
                  body: {
                    type: 'doc',
                    version: 1,
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }],
                  },
                },
              }
            : {}),
        };
        if (dryRun) return { dryRun: true, method: 'POST', path, body };
        return http.request({
          method: 'POST',
          path,
          body,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
    defineTool({
      name: 'jira.bulk_create_issues',
      description:
        'AC51: Bulk-create up to 50 issues in one `/rest/api/3/issue/bulk` POST (write — requires MCP_WRITE_ALLOWLIST entry). Returns partial success per issue. `dryRun: true` echoes the constructed payload.',
      inputSchema: BulkCreateIssuesInput,
      async handle({ issues, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const issueUpdates = issues.map(({ projectKey, summary, issueType, description }) => ({
          fields: {
            project: { key: projectKey },
            summary,
            issuetype: { name: issueType },
            ...(description
              ? {
                  description: {
                    type: 'doc',
                    version: 1,
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
                  },
                }
              : {}),
          },
        }));
        const body = { issueUpdates };
        if (dryRun) return { dryRun: true, method: 'POST', path: '/rest/api/3/issue/bulk', body };
        return http.request({
          method: 'POST',
          path: '/rest/api/3/issue/bulk',
          body,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
  );
}

// ── prompts (MCP `prompts/list` + `prompts/get`) ──────────────────────────
//
// Preconfigured slash-commands. Copilot Chat pokazuje je w pickerze, więc
// caller nie musi pisać JQL od zera dla typowych zapytań (assignment,
// sprint, epic breakdown).

const prompts: PromptDefinition[] = [
  definePrompt({
    name: 'jira.recent-issues',
    description: 'Fetch issues assigned to the current user, updated in the last 7 days. Copilot then drills in.',
    buildMessages: () => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Użyj `jira.search_issues` z JQL `assignee = currentUser() AND updated >= -7d ORDER BY updated DESC`, fields ["summary","status","priority","updated"], limit 25. Pokaż tabelę: key | summary | status | priority | updated.',
        },
      },
    ],
  }),
  definePrompt({
    name: 'jira.sprint-summary',
    description: 'Summarize current active sprint: stories with status, assignee, story points.',
    arguments: [{ name: 'projectKey', description: 'Jira project key (e.g. PROJ)', required: true }],
    buildMessages: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Dla projektu ${args['projectKey']}: użyj \`jira.search_issues\` z JQL \`project = ${args['projectKey']} AND sprint in openSprints()\`, fields ["summary","status","assignee","customfield_10016"]. Zgrupuj wyniki per status (To Do, In Progress, Done). Podsumuj velocity (sum story points done).`,
        },
      },
    ],
  }),
  definePrompt({
    name: 'jira.epic-breakdown',
    description: 'Pełen kontekst epicu: issue + children + linked issues + comments.',
    arguments: [{ name: 'epicKey', description: 'Epic issue key (e.g. PROJ-100)', required: true }],
    buildMessages: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Dla epicu ${args['epicKey']}:
1. \`jira.get_issue\` z include_comments=true, include_issuelinks=true.
2. \`jira.search_issues\` z JQL \`parent = ${args['epicKey']}\` (children).
3. Zsumuj: ile children, ile po statusie, ile blocked. Wyświetl jako tabelę + dependency graph (mermaid jeśli ≤ 15 nodów).`,
        },
      },
    ],
  }),
];

// ── resources (MCP `resources/list` + `resources/read`) ──────────────────
//
// Read-only docs ładowane przez Copilot jako kontekst (no LLM roundtrip).

const resources: ResourceDefinition[] = [
  defineMarkdownResource({
    uri: 'mcp-jira://docs/jql-cheatsheet',
    name: 'JQL cheatsheet',
    description: 'Operators, functions, common JQL patterns (assignee, sprint, parent, project).',
    file: 'jira-jql-cheatsheet.md',
  }),
  defineMarkdownResource({
    uri: 'mcp-jira://docs/custom-fields-guide',
    name: 'Jira custom fields guide',
    description: 'How `customfield_NNNNN` resolves to readable names via field-registry.',
    file: 'jira-custom-fields-guide.md',
  }),
];

// Re-exported dla konsumentów importujących moduł bez bootu (patrz `MCP_NO_BOOT` w `bootMcpServerIfEnabled`).
export { tools, prompts, resources };

await bootMcpServerIfEnabled({ name: SERVER_NAME, tools, prompts, resources });

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Jira's `worklog.started` rejects `Z` suffix — it needs `+0000` style. We
 * accept any ISO 8601 from the agent and rewrite it.
 */
function jiraStarted(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // 2026-05-19T08:30:00.000+0000
  return date.toISOString().replace('Z', '+0000');
}

type GetIssueInputT = z.infer<typeof GetIssueInput>;

/**
 * Build the comma-separated `fields=` query param for Jira REST. Bierze base z
 * `input.fields` (lub `DEFAULT_FIELDS` jeśli brak), dodaje opt-in fields zgodnie
 * z `include_*` flagami input'u (issuelinks / subtasks / attachment / comment / worklog).
 * @param input Validated input z `GetIssueInput` schema (z.infer).
 * @returns Comma-separated string gotowy do URL query.
 * @internal
 */
function buildFieldList(input: GetIssueInputT): string {
  const fields = [...(input.fields ?? DEFAULT_FIELDS)];
  if (input.include_issuelinks && !fields.includes('issuelinks')) fields.push('issuelinks');
  if (input.include_subtasks && !fields.includes('subtasks')) fields.push('subtasks');
  if (input.include_attachments && !fields.includes('attachment')) fields.push('attachment');
  if (input.include_comments && !fields.includes('comment')) fields.push('comment');
  if (input.include_worklog && !fields.includes('worklog')) fields.push('worklog');
  return fields.join(',');
}

/**
 * Build the `expand=` query param dla Jira REST. Always include `names` (potrzebne
 * dla custom field display labels); opcjonalnie dodaje `changelog` / `properties`
 * gdy odpowiednie include_* flagi są true.
 * @param input Validated input z `GetIssueInput` schema.
 * @returns Comma-separated string lub pusty string gdy brak expand.
 * @internal
 */
function buildExpandList(input: GetIssueInputT): string {
  const expand: string[] = ['names'];
  if (input.include_changelog) expand.push('changelog');
  if (input.include_properties) expand.push('properties');
  return expand.join(',');
}

interface IssueExtras {
  changelog?: ReturnType<typeof normaliseChangelogEntry>[];
  comments?: ReturnType<typeof normaliseComment>[];
  worklogs?: ReturnType<typeof normaliseWorklog>[];
  issueLinks?: ReturnType<typeof normaliseIssueLink>[];
  subtasks?: { key: string; summary: string; status?: string }[];
  attachments?: { id: string; filename: string; size: number; mimeType?: string; created?: string }[];
  properties?: Record<string, unknown>;
}

async function collectExtras(
  input: GetIssueInputT,
  raw: JiraIssueRaw,
  ctx: { correlationId: string; tool: string },
): Promise<IssueExtras> {
  const extras: IssueExtras = {};
  const fields = raw.fields ?? {};

  if (input.include_changelog) {
    const histories = raw.changelog?.histories ?? [];
    extras.changelog = histories.map((h) => normaliseChangelogEntry(h as RawChangelog));
  }
  if (input.include_comments) {
    const comments = (fields['comment'] as { comments?: readonly RawComment[] } | undefined)?.comments ?? [];
    extras.comments = comments.map((c) => normaliseComment(c));
  }
  if (input.include_worklog) {
    const worklogs = (fields['worklog'] as { worklogs?: readonly RawWorklog[] } | undefined)?.worklogs ?? [];
    extras.worklogs = worklogs.map((w) => normaliseWorklog(w));
  }
  if (input.include_issuelinks) {
    const links = (fields['issuelinks'] as readonly RawIssueLink[] | undefined) ?? [];
    extras.issueLinks = links.map((l) => normaliseIssueLink(l));
  }
  if (input.include_subtasks) {
    const subs = (fields['subtasks'] as readonly RawSubtask[] | undefined) ?? [];
    extras.subtasks = subs.map((s) => ({
      key: s.key ?? '',
      summary: s.fields?.summary ?? '',
      ...(s.fields?.status?.name ? { status: s.fields.status.name } : {}),
    }));
  }
  if (input.include_attachments) {
    const atts = (fields['attachment'] as readonly RawAttachment[] | undefined) ?? [];
    extras.attachments = atts.map((a) => ({
      id: a.id ?? '',
      filename: a.filename ?? '',
      size: a.size ?? 0,
      ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      ...(a.created ? { created: a.created } : {}),
    }));
  }
  if (input.include_properties) {
    // Properties live in a separate endpoint; do one extra call.
    const properties = await http
      .request<{ keys?: { key: string }[] }>({
        path: `/rest/api/3/issue/${input.key}/properties`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      })
      .catch(() => ({ keys: [] as { key: string }[] }));
    extras.properties = Object.fromEntries((properties.keys ?? []).map((k) => [k.key, true]));
  }
  return extras;
}

interface RawComment {
  readonly id?: string;
  readonly author?: { readonly accountId?: string; readonly displayName?: string };
  readonly body?: unknown;
  readonly created?: string;
  readonly updated?: string;
}

/**
 * Wyciąga minimalne `{ accountId, displayName }` z surowego Jira author objectu.
 * Jira raw user ma 12+ pól (avatarUrls, emailAddress, active, timeZone, …);
 * canonical to tylko 2 pola identyfikujące. Token saver dla agenta — patrz
 * `.github/instructions/llm-optimization.instructions.md` §8.
 * @param author Surowy author object lub undefined (gdy brak np. na anonymous comment).
 * @returns Canonical author lub undefined-as-empty.
 * @internal
 */
function pickAuthor(author: { readonly accountId?: string; readonly displayName?: string } | undefined): {
  author?: { accountId: string; displayName: string };
} {
  if (!author) return {};
  const accountId = author.accountId ?? '';
  const displayName = author.displayName ?? '';
  if (!accountId && !displayName) return {};
  return { author: { accountId, displayName } };
}

/**
 * Normalize raw Jira comment (z `/rest/api/3/issue/:key/comment`). Konwertuje
 * ADF body → Markdown przez `adfToMarkdown()` (~3× redukcja tokenów), wyciąga
 * minimal author + created/updated dates.
 * @param raw Surowy comment z Jira REST.
 * @returns Canonical kształt z `id` / `author` / `body` (markdown).
 * @internal
 */
function normaliseComment(raw: RawComment): {
  id: string;
  author?: { accountId: string; displayName: string };
  bodyMd: string;
  created?: string;
  updated?: string;
} {
  return {
    id: raw.id ?? '',
    ...pickAuthor(raw.author),
    bodyMd: adfToMarkdown(raw.body as AdfNode | string | null | undefined),
    ...(raw.created ? { created: raw.created } : {}),
    ...(raw.updated ? { updated: raw.updated } : {}),
  };
}

interface RawWorklog {
  readonly id?: string;
  readonly author?: { readonly accountId?: string; readonly displayName?: string };
  readonly started?: string;
  readonly timeSpent?: string;
  readonly timeSpentSeconds?: number;
  readonly comment?: unknown;
}

/**
 * Normalize raw Jira worklog entry. Reuses `pickAuthor()` + ADF→Markdown na
 * `comment` field (worklogowe komentarze mają ten sam ADF format co regular comments).
 * @param raw Surowy worklog z Jira REST.
 * @returns Canonical kształt z `id` / `author` / `timeSpentSeconds` / `started`.
 * @internal
 */
function normaliseWorklog(raw: RawWorklog): {
  id: string;
  author?: { accountId: string; displayName: string };
  started?: string;
  timeSpent?: string;
  timeSpentSeconds?: number;
  commentMd?: string;
} {
  return {
    id: raw.id ?? '',
    ...pickAuthor(raw.author),
    ...(raw.started ? { started: raw.started } : {}),
    ...(raw.timeSpent ? { timeSpent: raw.timeSpent } : {}),
    ...(typeof raw.timeSpentSeconds === 'number' ? { timeSpentSeconds: raw.timeSpentSeconds } : {}),
    ...(raw.comment ? { commentMd: adfToMarkdown(raw.comment as AdfNode | string | null | undefined) } : {}),
  };
}

interface RawChangelog {
  readonly id?: string;
  readonly created?: string;
  readonly author?: { readonly accountId?: string; readonly displayName?: string };
  readonly items?: readonly {
    readonly field?: string;
    readonly fieldtype?: string;
    readonly from?: string;
    readonly to?: string;
    readonly fromString?: string;
    readonly toString?: string;
  }[];
}

function normaliseChangelogEntry(raw: RawChangelog): {
  id: string;
  author?: { accountId: string; displayName: string };
  created?: string;
  items: { field: string; from?: string; to?: string }[];
} {
  return {
    id: raw.id ?? '',
    ...pickAuthor(raw.author),
    ...(raw.created ? { created: raw.created } : {}),
    items: (raw.items ?? []).map((i) => ({
      field: i.field ?? '',
      ...((i.fromString ?? i.from) ? { from: i.fromString ?? i.from } : {}),
      ...((i.toString ?? i.to) ? { to: i.toString ?? i.to } : {}),
    })),
  };
}

interface RawIssueLink {
  readonly id?: string;
  readonly type?: { readonly name?: string; readonly inward?: string; readonly outward?: string };
  readonly inwardIssue?: { readonly key?: string; readonly fields?: { readonly summary?: string } };
  readonly outwardIssue?: { readonly key?: string; readonly fields?: { readonly summary?: string } };
}

function pickIssueLinkLabel(type: RawIssueLink['type'], direction: 'inward' | 'outward'): string {
  if (direction === 'inward') return type?.inward ?? type?.name ?? '';
  return type?.outward ?? type?.name ?? '';
}

function normaliseIssueLink(raw: RawIssueLink): {
  id: string;
  type: string;
  direction: 'inward' | 'outward';
  issueKey: string;
  summary?: string;
} {
  const inwardIssue = raw.inwardIssue;
  const outwardIssue = raw.outwardIssue;
  const direction: 'inward' | 'outward' = inwardIssue?.key ? 'inward' : 'outward';
  const key = inwardIssue?.key ?? outwardIssue?.key ?? '';
  const summary = direction === 'inward' ? inwardIssue?.fields?.summary : outwardIssue?.fields?.summary;
  const typeLabel = pickIssueLinkLabel(raw.type, direction);
  return {
    id: raw.id ?? '',
    type: typeLabel,
    direction,
    issueKey: key,
    ...(summary ? { summary } : {}),
  };
}

interface RawSubtask {
  readonly key?: string;
  readonly fields?: { readonly summary?: string; readonly status?: { readonly name?: string } };
}

interface RawAttachment {
  readonly id?: string;
  readonly filename?: string;
  readonly size?: number;
  readonly mimeType?: string;
  readonly created?: string;
}
