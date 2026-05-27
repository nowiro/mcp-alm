#!/usr/bin/env node
/**
 * mcp-sonar — read tools for SonarQube / SonarCloud quality gate, issues, measures.
 *
 * `list_issues` uses Sonar's `p`/`ps` pagination (capped at 500 per page by
 * Sonar itself) and walks pages under a token budget so a noisy project
 * doesn't blow out the LLM context.
 */
import { z } from 'zod';

import { loadSonarAuth } from './shared/auth.js';
import { BudgetTracker } from './shared/budget.js';
import { extract } from './shared/extract.js';
import { createNamedHttpClient } from './shared/http-client.js';
import {
  bootMcpServerIfEnabled,
  defineTool,
  markTruncated,
  usageHistoryTool,
  type ToolDefinition,
} from './shared/mcp-server.js';
import { definePrompt, type PromptDefinition } from './shared/prompt.js';
import { defineMarkdownResource, type ResourceDefinition } from './shared/resource.js';
import { cursorAdapter } from './shared/pagination.js';
import { diffGateStatuses, type SonarProjectStatus } from './shared/sonar-gate-diff.js';
import {
  reshapeHotspot,
  reshapeSonarIssue,
  type CanonicalHotspot,
  type CanonicalSonarIssue,
} from './shared/sonar-reshape.js';

const SERVER_NAME = 'mcp-sonar';
const DEFAULT_BUDGET_TOKENS = 2500;

const ProjectKey = z.string().min(1);
const QualityGateInput = z.object({ projectKey: ProjectKey });
const IssuesInput = z.object({
  projectKey: ProjectKey,
  severities: z.array(z.enum(['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'])).optional(),
  types: z.array(z.enum(['CODE_SMELL', 'BUG', 'VULNERABILITY'])).optional(),
  branch: z.string().optional(),
  pullRequest: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(50),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
});
const MeasuresInput = z.object({
  projectKey: ProjectKey,
  metrics: z
    .array(z.string())
    .default(['coverage', 'bugs', 'vulnerabilities', 'code_smells', 'duplicated_lines_density']),
  branch: z.string().optional(),
  pullRequest: z.string().optional(),
});
const HotspotsInput = z.object({
  projectKey: ProjectKey,
  status: z.enum(['TO_REVIEW', 'REVIEWED']).optional(),
  limit: z.number().int().min(1).max(500).default(50),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
});
const ListProjectsInput = z.object({ limit: z.number().int().min(1).max(500).default(100) });
const QualityGateDiffInput = z.object({
  projectKey: ProjectKey,
  pullRequest: z.string().min(1),
  baseBranch: z.string().default('main'),
});

const http = createNamedHttpClient(SERVER_NAME, loadSonarAuth());

interface SonarPagedResponse<T> {
  readonly issues?: readonly T[];
  readonly hotspots?: readonly T[];
  readonly paging?: { readonly pageIndex: number; readonly pageSize: number; readonly total: number };
}

interface SonarProjectStatusResponse {
  readonly projectStatus?: SonarProjectStatus;
}

function sonarPaginator<Out>(
  path: string,
  baseQuery: Record<string, string | number | boolean | undefined>,
  itemsKey: 'issues' | 'hotspots',
  reshape: (raw: unknown) => Out,
  ctx: { correlationId: string; tool: string },
): ReturnType<typeof cursorAdapter<Out, { items: readonly Out[]; next?: string }>> {
  return cursorAdapter<Out, { items: readonly Out[]; next?: string }>(
    async (cursor) => {
      const page = Number(cursor ?? '1') || 1;
      const raw = await http.request<SonarPagedResponse<unknown>>({
        path,
        query: { ...baseQuery, p: page },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const rawItems = (itemsKey === 'issues' ? raw.issues : raw.hotspots) ?? [];
      const items = rawItems.map((r) => reshape(r));
      const total = raw.paging?.total ?? 0;
      const pageSize = raw.paging?.pageSize ?? Number(baseQuery['ps'] ?? 50);
      const next = page * pageSize < total ? String(page + 1) : undefined;
      return { items, next };
    },
    (raw) => raw.items,
    (raw) => raw.next,
  );
}

const tools: ToolDefinition[] = [
  defineTool({
    name: 'sonar.quality_gate',
    description: 'Fetch the project quality-gate status.',
    inputSchema: QualityGateInput,
    async handle({ projectKey }, ctx) {
      return http.request({
        path: '/api/qualitygates/project_status',
        query: { projectKey },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'sonar.list_issues',
    description: 'List issues for a project, filterable by severity / type / branch / pull request. Paginated.',
    inputSchema: IssuesInput,
    async handle({ projectKey, severities, types, branch, pullRequest, limit, budgetTokens }, ctx) {
      const budget = new BudgetTracker(budgetTokens);
      const baseQuery = {
        componentKeys: projectKey,
        ps: Math.min(100, limit),
        ...(severities && severities.length > 0 ? { severities: severities.join(',') } : {}),
        ...(types && types.length > 0 ? { types: types.join(',') } : {}),
        ...(branch ? { branch } : {}),
        ...(pullRequest ? { pullRequest } : {}),
      };
      const fetchPage = sonarPaginator<CanonicalSonarIssue>(
        '/api/issues/search',
        baseQuery,
        'issues',
        (r) => reshapeSonarIssue(r as Parameters<typeof reshapeSonarIssue>[0]),
        ctx,
      );
      const result = await extract<CanonicalSonarIssue, CanonicalSonarIssue>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: limit,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'sonar.list_hotspots',
    description: 'List security hotspots for a project. Paginated. Returns canonical shape.',
    inputSchema: HotspotsInput,
    async handle({ projectKey, status, limit, budgetTokens }, ctx) {
      const budget = new BudgetTracker(budgetTokens);
      const baseQuery = {
        projectKey,
        ps: Math.min(100, limit),
        ...(status ? { status } : {}),
      };
      const fetchPage = sonarPaginator<CanonicalHotspot>(
        '/api/hotspots/search',
        baseQuery,
        'hotspots',
        (r) => reshapeHotspot(r as Parameters<typeof reshapeHotspot>[0]),
        ctx,
      );
      const result = await extract<CanonicalHotspot, CanonicalHotspot>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: limit,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'sonar.get_hotspot',
    description: 'Fetch one hotspot by key (raw upstream — includes context lines + rule description).',
    inputSchema: z.object({ hotspotKey: z.string().min(1) }),
    async handle({ hotspotKey }, ctx) {
      return http.request({
        path: '/api/hotspots/show',
        query: { hotspot: hotspotKey },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'sonar.health',
    description: 'Smoke-test the upstream + token: GET /api/system/status. Returns { ok, status, durationMs }.',
    inputSchema: z.object({}),
    async handle(_input, ctx) {
      const start = Date.now();
      const raw = await http.request<{ status?: string }>({
        path: '/api/system/status',
        cache: false,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { ok: true, status: raw.status ?? 'UNKNOWN', durationMs: Date.now() - start };
    },
  }),
  defineTool({
    name: 'sonar.measures',
    description: 'Fetch metric values for a project. Supports branch / pull-request scoped reads.',
    inputSchema: MeasuresInput,
    async handle({ projectKey, metrics, branch, pullRequest }, ctx) {
      return http.request({
        path: '/api/measures/component',
        query: {
          component: projectKey,
          metricKeys: metrics.join(','),
          ...(branch ? { branch } : {}),
          ...(pullRequest ? { pullRequest } : {}),
        },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'sonar.list_projects',
    description: 'List Sonar projects the user can browse.',
    inputSchema: ListProjectsInput,
    async handle({ limit }, ctx) {
      return http.request({
        path: '/api/projects/search',
        query: { ps: limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'sonar.get_quality_gate_diff',
    description:
      'Diff the quality-gate of a pull request against its base branch. Returns regressions, improvements, and a net-change summary so callers can decide whether the PR is safe to merge.',
    inputSchema: QualityGateDiffInput,
    async handle({ projectKey, pullRequest, baseBranch }, ctx) {
      const [prRaw, baseRaw] = await Promise.all([
        http.request<SonarProjectStatusResponse>({
          path: '/api/qualitygates/project_status',
          query: { projectKey, pullRequest },
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        }),
        http.request<SonarProjectStatusResponse>({
          path: '/api/qualitygates/project_status',
          query: { projectKey, branch: baseBranch },
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        }),
      ]);

      const prStatus: SonarProjectStatus = prRaw.projectStatus ?? { status: 'NONE' };
      const baseStatus: SonarProjectStatus = baseRaw.projectStatus ?? { status: 'NONE' };
      const diff = diffGateStatuses(prStatus, baseStatus);

      return {
        project: projectKey,
        pull_request: pullRequest,
        base: baseBranch,
        pr_status: prStatus.status,
        base_status: baseStatus.status,
        regressions: diff.regressions,
        improvements: diff.improvements,
        summary: diff.summary,
      };
    },
  }),
  usageHistoryTool(SERVER_NAME),
];

// ── prompts ────────────────────────────────────────────────────────────────

const prompts: PromptDefinition[] = [
  definePrompt({
    name: 'sonar.quality-gate-status',
    description: 'Current quality gate status for a project (pass/fail + per-condition breakdown).',
    arguments: [{ name: 'projectKey', description: 'Sonar project key', required: true }],
    buildMessages: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `\`sonar.quality_gate({ project: "${args['projectKey']}" })\`. Pokaż status (OK / ERROR / WARN) + tabelę: condition | actualValue | errorThreshold | status. Highlight czerwone.`,
        },
      },
    ],
  }),
  definePrompt({
    name: 'sonar.new-issues',
    description: 'Issues opened since the last release (defaults to last 30 days).',
    arguments: [{ name: 'projectKey', description: 'Sonar project key', required: true }],
    buildMessages: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `\`sonar.list_issues\` dla project \`${args['projectKey']}\` z \`createdAfter: -30d\`, \`statuses: ["OPEN","REOPENED"]\`. Pogrupuj per severity (BLOCKER/CRITICAL/MAJOR/MINOR), pokaż top 20 BLOCKER+CRITICAL z component + rule + line.`,
        },
      },
    ],
  }),
];

// ── resources (MCP `resources/list` + `resources/read`) ──────────────────

const resources: ResourceDefinition[] = [
  defineMarkdownResource({
    uri: 'mcp-sonar://docs/severity-guide',
    name: 'Sonar severity guide',
    description: 'BLOCKER / CRITICAL / MAJOR / MINOR / INFO — what each level means + triage hints.',
    file: 'sonar-severity-guide.md',
  }),
];

// Re-exported dla konsumentów importujących moduł bez bootu (patrz `MCP_NO_BOOT` w `bootMcpServerIfEnabled`).
export { tools, prompts, resources };

await bootMcpServerIfEnabled({ name: SERVER_NAME, tools, prompts, resources });
