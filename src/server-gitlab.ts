#!/usr/bin/env node
/**
 * mcp-gitlab — read tools for GitLab projects, MRs, issues, pipelines.
 *
 * Every list endpoint returns canonical shapes (`gitlab-reshape.ts`) so the
 * agent sees ~10 fields per MR instead of 60+. List endpoints walk pages
 * under a token budget, identical to Jira / Confluence.
 */
import { z } from 'zod';

import { loadGitLabAuth } from './shared/auth.js';
import { BudgetTracker } from './shared/budget.js';
import { SecurityError } from './shared/errors.js';
import { extract } from './shared/extract.js';
import { tailBytes } from './shared/gitlab-job-log.js';
import {
  reshapeGitLabIssue,
  reshapeGitLabMr,
  reshapeGitLabPipeline,
  type CanonicalGitLabIssue,
  type CanonicalMr,
  type CanonicalPipeline,
} from './shared/gitlab-reshape.js';
import { createNamedHttpClient } from './shared/http-client.js';
import {
  bootMcpServerIfEnabled,
  defineTool,
  markTruncated,
  usageHistoryTool,
  type ToolDefinition,
} from './shared/mcp-server.js';
import { cursorAdapter } from './shared/pagination.js';
import { assertWriteAllowed, isWriteEnabled } from './shared/write-guard.js';

const SERVER_NAME = 'mcp-gitlab';
const DEFAULT_BUDGET_TOKENS = 2500;

const ProjectId = z.union([z.string().min(1), z.number().int().min(1)]);
const GetMrInput = z.object({ projectId: ProjectId, iid: z.number().int().min(1) });
const ListMrsInput = z.object({
  projectId: ProjectId,
  state: z.enum(['opened', 'closed', 'merged', 'all']).default('opened'),
  limit: z.number().int().min(1).max(100).default(30),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
});
const ListIssuesInput = z.object({
  projectId: ProjectId,
  state: z.enum(['opened', 'closed', 'all']).default('opened'),
  labels: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
});
const ListPipelinesInput = z.object({
  projectId: ProjectId,
  ref: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
});
const GetFileInput = z.object({
  projectId: ProjectId,
  path: z.string().min(1),
  ref: z.string().min(1),
});
const GetPipelineJobsInput = z.object({
  projectId: ProjectId,
  pipelineId: z.number().int().min(1),
  limit: z.number().int().min(1).max(100).default(50),
});
const GetJobLogInput = z.object({
  projectId: ProjectId,
  jobId: z.number().int().min(1),
  tailKb: z.number().int().min(1).max(1024).default(64),
});
const GetCommitInput = z.object({
  projectId: ProjectId,
  sha: z.string().regex(/^[a-f0-9]{6,40}$/i),
});
const ListBranchesInput = z.object({
  projectId: ProjectId,
  search: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
const HealthInput = z.object({});

const CreateIssueInput = z.object({
  projectId: ProjectId,
  title: z.string().min(1).max(256),
  description: z.string().max(65_536).optional(),
  labels: z.array(z.string().min(1)).max(50).optional(),
  assigneeIds: z.array(z.number().int().min(1)).max(10).optional(),
  dryRun: z.boolean().default(false),
});
const CreateMrInput = z.object({
  projectId: ProjectId,
  title: z.string().min(1).max(256),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  description: z.string().max(65_536).optional(),
  removeSourceBranch: z.boolean().default(false),
  squash: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
const MergeMrInput = z.object({
  projectId: ProjectId,
  iid: z.number().int().min(1),
  mergeCommitMessage: z.string().max(65_536).optional(),
  squash: z.boolean().default(false),
  shouldRemoveSourceBranch: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

const encodeProject = (id: string | number): string => encodeURIComponent(String(id));

const http = createNamedHttpClient(SERVER_NAME, loadGitLabAuth());

/** GitLab paginates via `x-next-page` header — we mirror that into the response. */
function gitlabPageFetcher<TIn, TOut>(
  path: string,
  baseQuery: Record<string, string | number | boolean | undefined>,
  reshape: (raw: TIn) => TOut,
  ctx: { correlationId: string; tool: string },
): ReturnType<typeof cursorAdapter<TOut, { items: readonly TIn[]; next?: string }>> {
  return cursorAdapter<TOut, { items: readonly TIn[]; next?: string }>(
    async (cursor) => {
      const page = await http.request<readonly TIn[]>({
        path,
        query: { ...baseQuery, ...(cursor ? { page: cursor } : {}) },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      // GitLab returns the page array directly; cursor is in headers we can't see
      // through fetch's parsed JSON. Synthesise: if we got a full page, ask for next.
      const pageSize = Number(baseQuery['per_page'] ?? 30);
      const next = page.length === pageSize ? String((Number(cursor ?? '1') || 1) + 1) : undefined;
      return { items: page, next };
    },
    (raw) => raw.items.map((i) => reshape(i)),
    (raw) => raw.next,
  );
}

const tools: ToolDefinition[] = [
  defineTool({
    name: 'gitlab.get_mr',
    description: 'Fetch one merge request by iid. Returns canonical shape (title, state, branches, labels, stats).',
    inputSchema: GetMrInput,
    async handle({ projectId, iid }, ctx) {
      const raw = await http.request<Parameters<typeof reshapeGitLabMr>[0]>({
        path: `/projects/${encodeProject(projectId)}/merge_requests/${iid}`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return reshapeGitLabMr(raw);
    },
  }),
  defineTool({
    name: 'gitlab.list_mrs',
    description: 'List merge requests on a project. Walks pages under a token budget; returns canonical shapes.',
    inputSchema: ListMrsInput,
    async handle({ projectId, state, limit, budgetTokens }, ctx) {
      const budget = new BudgetTracker(budgetTokens);
      const fetchPage = gitlabPageFetcher<Parameters<typeof reshapeGitLabMr>[0], CanonicalMr>(
        `/projects/${encodeProject(projectId)}/merge_requests`,
        { state, per_page: Math.min(50, limit) },
        reshapeGitLabMr,
        ctx,
      );
      const result = await extract<CanonicalMr, CanonicalMr>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: limit,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'gitlab.list_issues',
    description: 'List issues on a project. Walks pages under a token budget; returns canonical shapes.',
    inputSchema: ListIssuesInput,
    async handle({ projectId, state, labels, limit, budgetTokens }, ctx) {
      const budget = new BudgetTracker(budgetTokens);
      const fetchPage = gitlabPageFetcher<Parameters<typeof reshapeGitLabIssue>[0], CanonicalGitLabIssue>(
        `/projects/${encodeProject(projectId)}/issues`,
        { state, per_page: Math.min(50, limit), ...(labels ? { labels } : {}) },
        reshapeGitLabIssue,
        ctx,
      );
      const result = await extract<CanonicalGitLabIssue, CanonicalGitLabIssue>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: limit,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'gitlab.list_pipelines',
    description: 'List recent pipelines. Returns canonical shapes (id, status, ref, sha).',
    inputSchema: ListPipelinesInput,
    async handle({ projectId, ref, limit, budgetTokens }, ctx) {
      const budget = new BudgetTracker(budgetTokens);
      const fetchPage = gitlabPageFetcher<Parameters<typeof reshapeGitLabPipeline>[0], CanonicalPipeline>(
        `/projects/${encodeProject(projectId)}/pipelines`,
        { per_page: Math.min(50, limit), ...(ref ? { ref } : {}) },
        reshapeGitLabPipeline,
        ctx,
      );
      const result = await extract<CanonicalPipeline, CanonicalPipeline>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: limit,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'gitlab.get_file_content',
    description: 'Fetch a file from a repo at a given ref (raw text).',
    inputSchema: GetFileInput,
    async handle({ projectId, path, ref }, ctx) {
      assertSafePath(path);
      return http.request<string>({
        path: `/projects/${encodeProject(projectId)}/repository/files/${encodeURIComponent(path)}/raw`,
        query: { ref },
        responseMode: 'text',
        accept: 'text/plain, */*',
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'gitlab.get_pipeline_jobs',
    description: 'List jobs for a pipeline (name, stage, status, duration). Useful for "which step failed?".',
    inputSchema: GetPipelineJobsInput,
    async handle({ projectId, pipelineId, limit }, ctx) {
      const raw = await http.request<readonly RawPipelineJob[]>({
        path: `/projects/${encodeProject(projectId)}/pipelines/${pipelineId}/jobs`,
        query: { per_page: limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { jobs: raw.map((job) => normalisePipelineJob(job)) };
    },
  }),
  defineTool({
    name: 'gitlab.get_job_log',
    description:
      'Fetch a CI job trace (raw text). Returns the last `tailKb` kilobytes plus the total byte count so callers can spot truncation without re-downloading.',
    inputSchema: GetJobLogInput,
    async handle({ projectId, jobId, tailKb }, ctx) {
      const fullLog = await http.request<string>({
        path: `/projects/${encodeProject(projectId)}/jobs/${jobId}/trace`,
        responseMode: 'text',
        accept: 'text/plain, */*',
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const tail = tailBytes(fullLog, tailKb);
      return {
        projectId,
        jobId,
        log: tail.content,
        totalBytes: tail.totalBytes,
        returnedBytes: tail.returnedBytes,
        truncated: tail.truncated,
      };
    },
  }),
  defineTool({
    name: 'gitlab.get_commit',
    description: 'Fetch one commit by SHA (author, message, stats).',
    inputSchema: GetCommitInput,
    async handle({ projectId, sha }, ctx) {
      const raw = await http.request<RawCommit>({
        path: `/projects/${encodeProject(projectId)}/repository/commits/${sha}`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return normaliseCommit(raw);
    },
  }),
  defineTool({
    name: 'gitlab.list_branches',
    description: 'List branches on a project, optionally filtered by `search`.',
    inputSchema: ListBranchesInput,
    async handle({ projectId, search, limit }, ctx) {
      const raw = await http.request<readonly RawBranch[]>({
        path: `/projects/${encodeProject(projectId)}/repository/branches`,
        query: { per_page: limit, ...(search ? { search } : {}) },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { branches: raw.map((b) => normaliseBranch(b)) };
    },
  }),
  defineTool({
    name: 'gitlab.health',
    description: 'Smoke-test the upstream + token: GET /user. Returns { ok, durationMs } or throws.',
    inputSchema: HealthInput,
    async handle(_input, ctx) {
      const start = Date.now();
      await http.request({ path: '/user', cache: false, correlationId: ctx.correlationId, tool: ctx.tool });
      return { ok: true, durationMs: Date.now() - start };
    },
  }),
  usageHistoryTool(SERVER_NAME),
  defineTool({
    name: 'gitlab.merge_request_changes',
    description:
      'AC55: Fetch the per-file diff for a Merge Request (`/projects/:id/merge_requests/:iid/changes`). Returns canonical shape with new/old paths, additions/deletions, and renamed/deleted flags. Diff body trimmed to `maxBytesPerFile` (default 8 KB).',
    inputSchema: z.object({
      projectId: z.union([z.string().min(1), z.number().int().min(1)]),
      iid: z.number().int().min(1),
      maxBytesPerFile: z.number().int().min(500).max(100_000).default(8000),
    }),
    async handle({ projectId, iid, maxBytesPerFile }, ctx) {
      interface RawChange {
        readonly old_path?: string;
        readonly new_path?: string;
        readonly a_mode?: string;
        readonly b_mode?: string;
        readonly diff?: string;
        readonly new_file?: boolean;
        readonly renamed_file?: boolean;
        readonly deleted_file?: boolean;
      }
      interface RawMrChanges {
        readonly changes?: readonly RawChange[];
        readonly diff_refs?: unknown;
      }
      const raw = await http.request<RawMrChanges>({
        path: `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${iid}/changes`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const changes = (raw.changes ?? []).map((c) => {
        const diffTrunc = c.diff && c.diff.length > maxBytesPerFile;
        return {
          ...(c.new_path ? { newPath: c.new_path } : {}),
          ...(c.old_path && c.old_path !== c.new_path ? { oldPath: c.old_path } : {}),
          ...(c.new_file ? { newFile: true } : {}),
          ...(c.renamed_file ? { renamed: true } : {}),
          ...(c.deleted_file ? { deleted: true } : {}),
          ...(c.diff ? { diff: diffTrunc ? `${c.diff.slice(0, maxBytesPerFile)}\n…[truncated]` : c.diff } : {}),
          ...(diffTrunc ? { diffTruncated: true } : {}),
        };
      });
      return { changes, count: changes.length };
    },
  }),
  defineTool({
    name: 'gitlab.get_artifacts',
    description:
      'AC55: List CI/CD job artifacts (`/projects/:id/jobs/:job_id/artifacts/`). Returns linki + file metadata bez pobrania bytes — agent decyduje czy ściągać konkretny artifact osobno.',
    inputSchema: z.object({
      projectId: z.union([z.string().min(1), z.number().int().min(1)]),
      jobId: z.number().int().min(1),
    }),
    async handle({ projectId, jobId }, ctx) {
      interface RawJob {
        readonly id: number;
        readonly name?: string;
        readonly status?: string;
        readonly artifacts_file?: { readonly filename?: string; readonly size?: number };
        readonly artifacts?: readonly {
          readonly filename?: string;
          readonly size?: number;
          readonly file_type?: string;
        }[];
        readonly web_url?: string;
      }
      const raw = await http.request<RawJob>({
        path: `/projects/${encodeURIComponent(String(projectId))}/jobs/${jobId}`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const baseUrl = `/projects/${encodeURIComponent(String(projectId))}/jobs/${jobId}/artifacts`;
      const archive = raw.artifacts_file
        ? {
            ...(raw.artifacts_file.filename ? { filename: raw.artifacts_file.filename } : {}),
            ...(typeof raw.artifacts_file.size === 'number' && raw.artifacts_file.size > 0
              ? { sizeBytes: raw.artifacts_file.size }
              : {}),
            downloadPath: baseUrl,
          }
        : undefined;
      const items = (raw.artifacts ?? []).map((a) => ({
        ...(a.filename ? { filename: a.filename } : {}),
        ...(typeof a.size === 'number' && a.size > 0 ? { sizeBytes: a.size } : {}),
        ...(a.file_type ? { type: a.file_type } : {}),
      }));
      return {
        jobId: raw.id,
        ...(raw.name ? { name: raw.name } : {}),
        ...(raw.status ? { status: raw.status } : {}),
        ...(archive ? { archive } : {}),
        items,
        ...(raw.web_url ? { jobUrl: raw.web_url } : {}),
      };
    },
  }),
];

if (isWriteEnabled()) {
  tools.push(
    defineTool({
      name: 'gitlab.create_issue',
      description:
        'Create a GitLab issue (write — requires MCP_WRITE_ALLOWLIST entry). `dryRun: true` echoes the request.',
      inputSchema: CreateIssueInput,
      async handle({ projectId, title, description, labels, assigneeIds, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = `/projects/${encodeProject(projectId)}/issues`;
        const body = {
          title,
          ...(description ? { description } : {}),
          ...(labels && labels.length > 0 ? { labels: labels.join(',') } : {}),
          ...(assigneeIds && assigneeIds.length > 0 ? { assignee_ids: assigneeIds } : {}),
        };
        if (dryRun) return { dryRun: true, method: 'POST', path, body };
        return http.request({ method: 'POST', path, body, correlationId: ctx.correlationId, tool: ctx.tool });
      },
    }),
    defineTool({
      name: 'gitlab.create_mr',
      description: 'Open a merge request (write — requires MCP_WRITE_ALLOWLIST entry).',
      inputSchema: CreateMrInput,
      async handle(
        { projectId, title, sourceBranch, targetBranch, description, removeSourceBranch, squash, dryRun },
        ctx,
      ) {
        assertWriteAllowed(ctx.tool);
        const path = `/projects/${encodeProject(projectId)}/merge_requests`;
        const body = {
          title,
          source_branch: sourceBranch,
          target_branch: targetBranch,
          ...(description ? { description } : {}),
          ...(removeSourceBranch ? { remove_source_branch: true } : {}),
          ...(squash ? { squash: true } : {}),
        };
        if (dryRun) return { dryRun: true, method: 'POST', path, body };
        return http.request({ method: 'POST', path, body, correlationId: ctx.correlationId, tool: ctx.tool });
      },
    }),
    defineTool({
      name: 'gitlab.merge_mr',
      description: 'Merge a merge request (write — requires MCP_WRITE_ALLOWLIST entry).',
      inputSchema: MergeMrInput,
      async handle({ projectId, iid, mergeCommitMessage, squash, shouldRemoveSourceBranch, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = `/projects/${encodeProject(projectId)}/merge_requests/${iid}/merge`;
        const body = {
          ...(mergeCommitMessage ? { merge_commit_message: mergeCommitMessage } : {}),
          ...(squash ? { squash: true } : {}),
          ...(shouldRemoveSourceBranch ? { should_remove_source_branch: true } : {}),
        };
        if (dryRun) return { dryRun: true, method: 'PUT', path, body };
        return http.request({ method: 'PUT', path, body, correlationId: ctx.correlationId, tool: ctx.tool });
      },
    }),
  );
}

// Re-exported dla konsumentów importujących moduł bez bootu (patrz `MCP_NO_BOOT` w `bootMcpServerIfEnabled`).
export { tools };

await bootMcpServerIfEnabled({ name: SERVER_NAME, tools });

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Reject path-traversal sequences before we hand the path to encodeURIComponent.
 * GitLab itself filters these on the server side, but defence in depth keeps a
 * compromised agent from probing private files.
 */
function assertSafePath(path: string): void {
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
    throw new SecurityError(`refusing unsafe path "${path}"`, 'gitlab');
  }
}

interface RawPipelineJob {
  readonly id?: number;
  readonly name?: string;
  readonly stage?: string;
  readonly status?: string;
  readonly duration?: number;
  readonly created_at?: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly web_url?: string;
}

function normalisePipelineJob(raw: RawPipelineJob): {
  id: number;
  name: string;
  stage: string;
  status: string;
  duration?: number;
  startedAt?: string;
  finishedAt?: string;
  url?: string;
} {
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    stage: raw.stage ?? '',
    status: raw.status ?? 'unknown',
    ...(typeof raw.duration === 'number' ? { duration: raw.duration } : {}),
    ...(raw.started_at ? { startedAt: raw.started_at } : {}),
    ...(raw.finished_at ? { finishedAt: raw.finished_at } : {}),
    ...(raw.web_url ? { url: raw.web_url } : {}),
  };
}

interface RawCommit {
  readonly id?: string;
  readonly short_id?: string;
  readonly title?: string;
  readonly message?: string;
  readonly author_name?: string;
  readonly author_email?: string;
  readonly authored_date?: string;
  readonly committed_date?: string;
  readonly web_url?: string;
  readonly stats?: { readonly additions?: number; readonly deletions?: number; readonly total?: number };
}

function normaliseCommit(raw: RawCommit): {
  sha: string;
  shortSha: string;
  title: string;
  messageMd?: string;
  author?: { name: string; email: string };
  authoredAt?: string;
  committedAt?: string;
  url?: string;
  stats?: { additions?: number; deletions?: number; total?: number };
} {
  const author =
    raw.author_name || raw.author_email ? { name: raw.author_name ?? '', email: raw.author_email ?? '' } : undefined;
  return {
    sha: raw.id ?? '',
    shortSha: raw.short_id ?? '',
    title: raw.title ?? '',
    ...(raw.message ? { messageMd: raw.message } : {}),
    ...(author ? { author } : {}),
    ...(raw.authored_date ? { authoredAt: raw.authored_date } : {}),
    ...(raw.committed_date ? { committedAt: raw.committed_date } : {}),
    ...(raw.web_url ? { url: raw.web_url } : {}),
    ...(raw.stats ? { stats: raw.stats } : {}),
  };
}

interface RawBranch {
  readonly name?: string;
  readonly default?: boolean;
  readonly protected?: boolean;
  readonly commit?: { readonly id?: string; readonly short_id?: string };
  readonly web_url?: string;
}

function normaliseBranch(raw: RawBranch): {
  name: string;
  default?: boolean;
  protected?: boolean;
  sha?: string;
  url?: string;
} {
  return {
    name: raw.name ?? '',
    ...(raw.default ? { default: true } : {}),
    ...(raw.protected ? { protected: true } : {}),
    ...(raw.commit?.id ? { sha: raw.commit.id } : {}),
    ...(raw.web_url ? { url: raw.web_url } : {}),
  };
}
