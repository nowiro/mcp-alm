#!/usr/bin/env node
/**
 * mcp-confluence — read tools for Confluence pages, search, and spaces.
 *
 * Body handling:
 *   - `get_page` requests `atlas_doc_format` (ADF JSON) instead of HTML and
 *     pipes the body through `adfToMarkdown`. Large pages are truncated at
 *     `maxChars` (default 5 000 chars) and flagged with `truncated: true`.
 *     Add `mode: 'summary'` for a cheap intro+headings overview instead of
 *     the whole page.
 *   - `search_pages` returns a paginated, budget-aware list of trimmed results
 *     under `budgetTokens` (default 2 500 tokens).
 */
import { z } from 'zod';

import { loadConfluenceAuth } from './shared/auth.js';
import { BudgetTracker } from './shared/budget.js';
import { buildLabelSearchCql } from './shared/confluence-cql.js';
import { reshapeConfluencePage } from './shared/confluence-reshape.js';
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
import { adfToMarkdown, type AdfNode } from './shared/adf.js';
import { assertWriteAllowed, isWriteEnabled } from './shared/write-guard.js';

const SERVER_NAME = 'mcp-confluence';
const DEFAULT_MAX_CHARS = 5000;
const DEFAULT_BUDGET_TOKENS = 2500;

const PageId = z.string().regex(/^\d+$/);
const GetPageInput = z.object({
  pageId: PageId,
  maxChars: z.number().int().min(500).max(200_000).default(DEFAULT_MAX_CHARS),
  mode: z.enum(['full', 'summary']).default('full'),
});
const SearchInput = z.object({
  cql: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(25),
  budgetTokens: z.number().int().min(500).max(80_000).default(DEFAULT_BUDGET_TOKENS),
});
const SearchPagesByLabelInput = z.object({
  labels: z.array(z.string().min(1)).min(1).max(10),
  space: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
const ListSpacesInput = z.object({ limit: z.number().int().min(1).max(250).default(50) });
const ListChildrenInput = z.object({
  pageId: PageId,
  limit: z.number().int().min(1).max(250).default(50),
});
const ListAncestorsInput = z.object({ pageId: PageId });
const GetAttachmentsInput = z.object({
  pageId: PageId,
  limit: z.number().int().min(1).max(250).default(50),
});
/**
 * AC54 — Confluence write tools (create_page / update_page / attach_file).
 * Wszystkie z `dryRun: true` żeby zwrócić preview bez hitting upstream.
 *
 * MD → ADF: split body po `\n\n` → każdy bloczek jako paragraph; jednolinijkowy
 * Markdown bez nagłówków / list zostaje surowy. Pełny MD → ADF (heading, list,
 * code block, link) jako follow-up gdy use case wymaga formatowania.
 */
const CreatePageInput = z.object({
  spaceId: z.string().min(1),
  title: z.string().min(1).max(255),
  bodyMd: z.string().min(1).max(100_000),
  parentId: z.string().regex(/^\d+$/).optional(),
  status: z.enum(['current', 'draft']).default('current'),
  dryRun: z.boolean().default(false),
});
const UpdatePageInput = z.object({
  pageId: PageId,
  title: z.string().min(1).max(255).optional(),
  bodyMd: z.string().min(1).max(100_000).optional(),
  /** Bieżący numer wersji (z `get_page._version`); Confluence wymaga `current + 1` na update. */
  version: z.number().int().min(1),
  dryRun: z.boolean().default(false),
});
const AttachFileInput = z.object({
  pageId: PageId,
  filename: z.string().min(1).max(255),
  /** Base64-encoded file bytes. */
  contentBase64: z.string().min(1),
  contentType: z.string().min(1).default('application/octet-stream'),
  comment: z.string().max(1024).optional(),
  dryRun: z.boolean().default(false),
});

const GetCommentsInput = z.object({
  pageId: PageId,
  limit: z.number().int().min(1).max(250).default(50),
});
const AddCommentInput = z.object({
  pageId: PageId,
  body: z.string().min(1).max(32_768),
  dryRun: z.boolean().default(false),
});
const HealthInput = z.object({});

const http = createNamedHttpClient(SERVER_NAME, loadConfluenceAuth());

interface SearchResponse {
  readonly results: readonly { content?: { id?: string; title?: string }; title?: string }[];
  readonly _links?: { readonly next?: string };
}

interface Hit {
  readonly id: string;
  readonly title: string;
}

const tools: ToolDefinition[] = [
  defineTool({
    name: 'confluence.get_page',
    description:
      'Fetch one Confluence page by id. Body returned as Markdown (ADF→md normalised); long bodies truncated with `truncated: true`. Pass `mode: "summary"` for intro + headings only.',
    inputSchema: GetPageInput,
    async handle({ pageId, maxChars, mode }, ctx) {
      const raw = await http.request<Parameters<typeof reshapeConfluencePage>[0]>({
        path: `/wiki/api/v2/pages/${pageId}`,
        query: { 'body-format': 'atlas_doc_format' },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const page = reshapeConfluencePage(raw, { maxChars, mode });
      return page.truncated ? markTruncated(page) : page;
    },
  }),
  defineTool({
    name: 'confluence.search_pages',
    description:
      'CQL search with budget-aware cursor pagination (default 2,500 tokens, max 80,000). Returns canonical hits + truncated flag; may walk multiple upstream pages.',
    inputSchema: SearchInput,
    async handle({ cql, limit, budgetTokens }, ctx) {
      const budget = new BudgetTracker(budgetTokens);
      const fetchPage = cursorAdapter<Hit, SearchResponse>(
        async (cursor) =>
          http.request<SearchResponse>({
            path: '/wiki/rest/api/search',
            query: { cql, limit: Math.min(50, limit), ...(cursor ? { cursor } : {}) },
            correlationId: ctx.correlationId,
            tool: ctx.tool,
          }),
        (raw) =>
          raw.results
            .map((r) => ({ id: r.content?.id ?? '', title: r.content?.title ?? r.title ?? '' }))
            .filter((r): r is Hit => r.id.length > 0),
        (raw) => raw._links?.next,
      );
      const result = await extract<Hit, Hit>({
        fetchPage,
        reshape: (item) => item,
        budget,
        maxItems: limit,
      });
      return result.truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'confluence.search_pages_by_label',
    description:
      'Label-scoped page search (OR semantics across labels, single upstream call, O(1)). Optionally scoped to one space. Returns canonical hits without pagination.',
    inputSchema: SearchPagesByLabelInput,
    async handle({ labels, space, limit }, ctx) {
      const cql = buildLabelSearchCql({ labels, ...(space ? { space } : {}) });
      const raw = await http.request<LabelSearchResponse>({
        path: '/wiki/rest/api/content/search',
        query: { cql, limit, expand: 'metadata.labels,version,space' },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const baseUrl = raw._links?.base ?? '';
      const pages = (raw.results ?? [])
        .map((r) => reshapeLabelSearchHit(r, baseUrl))
        .filter((p): p is LabelSearchHit => p.id.length > 0);
      const total = typeof raw.totalSize === 'number' ? raw.totalSize : pages.length;
      const truncated = total > pages.length;
      const result = { pages, total, truncated };
      return truncated ? markTruncated(result) : result;
    },
  }),
  defineTool({
    name: 'confluence.list_spaces',
    description: 'List spaces the user can browse.',
    inputSchema: ListSpacesInput,
    async handle({ limit }, ctx) {
      return http.request({
        path: '/wiki/api/v2/spaces',
        query: { limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'confluence.list_children',
    description: 'List child pages of a given page (one level down). Returns id + title only.',
    inputSchema: ListChildrenInput,
    async handle({ pageId, limit }, ctx) {
      const raw = await http.request<{ results?: readonly { id?: string; title?: string }[] }>({
        path: `/wiki/api/v2/pages/${pageId}/children`,
        query: { limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return {
        children: (raw.results ?? [])
          .map((r) => ({ id: r.id ?? '', title: r.title ?? '' }))
          .filter((r) => r.id.length > 0),
      };
    },
  }),
  defineTool({
    name: 'confluence.list_ancestors',
    description: 'List ancestor pages of a given page (root → parent). Useful for breadcrumbs.',
    inputSchema: ListAncestorsInput,
    async handle({ pageId }, ctx) {
      const raw = await http.request<{ results?: readonly { id?: string; title?: string }[] }>({
        path: `/wiki/api/v2/pages/${pageId}/ancestors`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return {
        ancestors: (raw.results ?? [])
          .map((r) => ({ id: r.id ?? '', title: r.title ?? '' }))
          .filter((r) => r.id.length > 0),
      };
    },
  }),
  defineTool({
    name: 'confluence.get_attachments',
    description: 'List attachments on a page (filename, size, mime type, download URL).',
    inputSchema: GetAttachmentsInput,
    async handle({ pageId, limit }, ctx) {
      const raw = await http.request<{ results?: readonly RawAttachment[] }>({
        path: `/wiki/api/v2/pages/${pageId}/attachments`,
        query: { limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { attachments: (raw.results ?? []).map((a) => normaliseAttachment(a)) };
    },
  }),
  defineTool({
    name: 'confluence.get_comments',
    description:
      'Fetch footer comments on a page (ADF → Markdown). Inline comments live on a separate endpoint; this tool returns page-level comments only.',
    inputSchema: GetCommentsInput,
    async handle({ pageId, limit }, ctx) {
      const raw = await http.request<{ results?: readonly RawComment[] }>({
        path: `/wiki/api/v2/pages/${pageId}/footer-comments`,
        query: { 'body-format': 'atlas_doc_format', limit },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { comments: (raw.results ?? []).map((c) => normaliseComment(c)) };
    },
  }),
  defineTool({
    name: 'confluence.health',
    description:
      'Smoke-test the upstream + token: requests /wiki/api/v2/spaces?limit=1. Returns { ok, baseUrl, durationMs } or throws.',
    inputSchema: HealthInput,
    async handle(_input, ctx) {
      const start = Date.now();
      await http.request({
        path: '/wiki/api/v2/spaces',
        query: { limit: 1 },
        cache: false,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { ok: true, durationMs: Date.now() - start };
    },
  }),
  usageHistoryTool(SERVER_NAME),
];

if (isWriteEnabled()) {
  tools.push(
    defineTool({
      name: 'confluence.add_comment',
      description:
        'Add a footer comment to a page (write — requires MCP_WRITE_ALLOWLIST entry). `dryRun: true` echoes the request body.',
      inputSchema: AddCommentInput,
      async handle({ pageId, body, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = '/wiki/api/v2/footer-comments';
        const requestBody = {
          pageId,
          body: {
            representation: 'atlas_doc_format',
            value: JSON.stringify(markdownToAdf(body)),
          },
        };
        if (dryRun) return { dryRun: true, method: 'POST', path, body: requestBody };
        return http.request({
          method: 'POST',
          path,
          body: requestBody,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
    defineTool({
      name: 'confluence.create_page',
      description:
        'AC54: Create a Confluence page (write — requires MCP_WRITE_ALLOWLIST entry). Wraps Markdown body w basic ADF (paragraph per bloczek). `dryRun: true` zwraca constructed body bez upstream hit.',
      inputSchema: CreatePageInput,
      async handle({ spaceId, title, bodyMd, parentId, status, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = '/wiki/api/v2/pages';
        const body = {
          spaceId,
          status,
          title,
          ...(parentId ? { parentId } : {}),
          body: {
            representation: 'atlas_doc_format',
            value: JSON.stringify(markdownToAdf(bodyMd)),
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
      name: 'confluence.update_page',
      description:
        'AC54: Update a Confluence page (write). Confluence v2 wymaga `version` = bieżący numer wersji; serwer ustawia `version.number = version + 1` w request body. `dryRun: true` echoes payload.',
      inputSchema: UpdatePageInput,
      async handle({ pageId, title, bodyMd, version, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = `/wiki/api/v2/pages/${pageId}`;
        const requestBody: Record<string, unknown> = {
          id: pageId,
          status: 'current',
          version: { number: version + 1 },
        };
        if (title) requestBody['title'] = title;
        if (bodyMd) {
          requestBody['body'] = {
            representation: 'atlas_doc_format',
            value: JSON.stringify(markdownToAdf(bodyMd)),
          };
        }
        if (dryRun) return { dryRun: true, method: 'PUT', path, body: requestBody };
        return http.request({
          method: 'PUT',
          path,
          body: requestBody,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
    defineTool({
      name: 'confluence.attach_file',
      description:
        'AC54: Attach a file to a Confluence page via multipart upload (write). `contentBase64` to base64-encoded file bytes; serwer dekoduje i wysyła do `/wiki/rest/api/content/{pageId}/child/attachment`. `dryRun: true` zwraca metadata bez upload.',
      inputSchema: AttachFileInput,
      async handle({ pageId, filename, contentBase64, contentType, comment, dryRun }, ctx) {
        assertWriteAllowed(ctx.tool);
        const path = `/wiki/rest/api/content/${pageId}/child/attachment`;
        const bytes = Buffer.from(contentBase64, 'base64');
        if (dryRun) {
          return {
            dryRun: true,
            method: 'POST',
            path,
            multipart: {
              filename,
              contentType,
              sizeBytes: bytes.length,
              ...(comment ? { comment } : {}),
            },
          };
        }
        // FormData jest globalny w Node 20+ (undici). `Blob` też.
        const form = new FormData();
        const blob = new Blob([bytes], { type: contentType });
        form.append('file', blob, filename);
        if (comment) form.append('comment', comment);
        // Atlassian wymaga `X-Atlassian-Token: no-check` przy multipart upload.
        return http.request({
          method: 'POST',
          path,
          body: form,
          correlationId: ctx.correlationId,
          tool: ctx.tool,
        });
      },
    }),
  );
}

/**
 * AC54: Minimalistyczny Markdown → ADF wrapper. Splittuje body na bloczki po
 * pustych liniach (`\n\n`), każdy bloczek staje się ADF `paragraph` z text node.
 *
 * Co działa (basic):
 *   - paragrafy oddzielone pustymi liniami
 *   - text inline (bez bold / italic / link inline)
 *
 * Co NIE działa (TODO follow-up gdy realna potrzeba):
 *   - heading, bullet list, numbered list, fenced code block
 *   - inline formatting (bold, italic, link)
 *   - tables, panels, mentions
 *
 * Dla bardziej zaawansowanego MD agent powinien dostarczyć surowy ADF JSON
 * jako przyszły parametr `bodyAdf?`. Ten wrapper covers 80% basic use cases.
 * @param markdown Markdown source string.
 * @returns ADF document.
 */
function markdownToAdf(markdown: string): { readonly type: 'doc'; readonly version: 1; readonly content: AdfNode[] } {
  const blocks = markdown.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  const content: AdfNode[] = blocks.map((block) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: block.trim() }],
  }));
  return { type: 'doc', version: 1, content };
}

// ── prompts ────────────────────────────────────────────────────────────────

const prompts: PromptDefinition[] = [
  definePrompt({
    name: 'confluence.recent-pages',
    description: 'Pages updated in the last 7 days within a space — Copilot pokazuje top 25.',
    arguments: [{ name: 'spaceKey', description: 'Confluence space key (e.g. ENG)', required: true }],
    buildMessages: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Użyj \`confluence.search_pages\` z CQL \`space = "${args['spaceKey']}" AND lastModified > now("-7d") ORDER BY lastModified DESC\`, limit 25. Tabela: title | updated | updatedBy.`,
        },
      },
    ],
  }),
  definePrompt({
    name: 'confluence.onboarding-search',
    description: 'Find onboarding-related pages (title CQL fuzzy match).',
    arguments: [{ name: 'spaceKey', description: 'Confluence space key', required: true }],
    buildMessages: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `\`confluence.search_pages\` z CQL \`space = "${args['spaceKey']}" AND (title ~ "onboarding" OR title ~ "getting started" OR title ~ "intro")\`. Pokaż jako listę linków + 1-liner z body excerpt.`,
        },
      },
    ],
  }),
  definePrompt({
    name: 'confluence.page-with-children',
    description: 'Get page + recursive children subtree (max depth 3).',
    arguments: [{ name: 'pageId', description: 'Confluence page ID', required: true }],
    buildMessages: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Dla page ${args['pageId']}: \`confluence.get_page\` (z attachments), potem \`confluence.list_children\` rekurencyjnie do depth 3. Sprezentuj jako mermaid tree + body excerpts.`,
        },
      },
    ],
  }),
];

// ── resources (MCP `resources/list` + `resources/read`) ──────────────────

const resources: ResourceDefinition[] = [
  defineMarkdownResource({
    uri: 'mcp-confluence://docs/cql-cheatsheet',
    name: 'CQL cheatsheet',
    description: 'Confluence Query Language — operators, functions, common patterns for `search_pages`.',
    file: 'confluence-cql-cheatsheet.md',
  }),
];

// Re-exported dla konsumentów importujących moduł bez bootu (patrz `MCP_NO_BOOT` w `bootMcpServerIfEnabled`).
export { tools, prompts, resources };

await bootMcpServerIfEnabled({ name: SERVER_NAME, tools, prompts, resources });

// ── helpers ────────────────────────────────────────────────────────────────

interface RawComment {
  readonly id?: string;
  readonly version?: { readonly number?: number; readonly createdAt?: string };
  readonly authorId?: string;
  readonly createdAt?: string;
  readonly body?: { readonly atlas_doc_format?: { readonly value?: unknown } };
}

function normaliseComment(raw: RawComment): {
  id: string;
  authorId?: string;
  createdAt?: string;
  version?: number;
  bodyMd: string;
} {
  const adfValue = raw.body?.atlas_doc_format?.value;
  let adf: AdfNode | string | null | undefined;
  if (typeof adfValue === 'string') {
    try {
      adf = JSON.parse(adfValue) as AdfNode;
    } catch {
      adf = adfValue;
    }
  } else {
    adf = adfValue as AdfNode | undefined;
  }
  return {
    id: raw.id ?? '',
    ...(raw.authorId ? { authorId: raw.authorId } : {}),
    ...(raw.createdAt ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.version?.number === 'number' ? { version: raw.version.number } : {}),
    bodyMd: adfToMarkdown(adf),
  };
}

interface RawAttachment {
  readonly id?: string;
  readonly title?: string;
  readonly mediaType?: string;
  readonly fileSize?: number;
  readonly _links?: { readonly download?: string };
}

function normaliseAttachment(raw: RawAttachment): {
  id: string;
  title: string;
  mediaType?: string;
  fileSize?: number;
  downloadUrl?: string;
} {
  return {
    id: raw.id ?? '',
    title: raw.title ?? '',
    ...(raw.mediaType ? { mediaType: raw.mediaType } : {}),
    ...(typeof raw.fileSize === 'number' ? { fileSize: raw.fileSize } : {}),
    ...(raw._links?.download ? { downloadUrl: raw._links.download } : {}),
  };
}

interface RawLabelSearchResult {
  readonly id?: string;
  readonly title?: string;
  readonly space?: { readonly key?: string };
  readonly version?: { readonly when?: string; readonly number?: number };
  readonly metadata?: {
    readonly labels?: {
      readonly results?: readonly { readonly name?: string }[];
    };
  };
  readonly _links?: { readonly webui?: string; readonly tinyui?: string };
}

interface LabelSearchResponse {
  readonly results?: readonly RawLabelSearchResult[];
  readonly totalSize?: number;
  readonly _links?: { readonly base?: string };
}

interface LabelSearchHit {
  readonly id: string;
  readonly title: string;
  readonly spaceKey?: string;
  readonly url?: string;
  readonly lastModified?: string;
  readonly labels: readonly string[];
}

function reshapeLabelSearchHit(raw: RawLabelSearchResult, baseUrl: string): LabelSearchHit {
  const webui = raw._links?.webui ?? '';
  let url: string | undefined;
  if (webui) {
    url = baseUrl ? `${baseUrl}${webui}` : webui;
  }
  const labels = (raw.metadata?.labels?.results ?? []).map((l) => l.name ?? '').filter((n) => n.length > 0);
  return {
    id: raw.id ?? '',
    title: raw.title ?? '',
    ...(raw.space?.key ? { spaceKey: raw.space.key } : {}),
    ...(url ? { url } : {}),
    ...(raw.version?.when ? { lastModified: raw.version.when } : {}),
    labels,
  };
}
