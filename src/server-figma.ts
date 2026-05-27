#!/usr/bin/env node
/**
 * mcp-figma — read tools for Figma files, nodes, and image renders.
 */
import { z } from 'zod';

import { loadFigmaAuth } from './shared/auth.js';
import { emitCss, emitScss, emitTs, type Token, type TokenKind } from './shared/figma-tokens.js';
import { createNamedHttpClient } from './shared/http-client.js';
import { bootMcpServerIfEnabled, defineTool, usageHistoryTool, type ToolDefinition } from './shared/mcp-server.js';
import { definePrompt, type PromptDefinition } from './shared/prompt.js';
import { defineMarkdownResource, type ResourceDefinition } from './shared/resource.js';

const SERVER_NAME = 'mcp-figma';

const FileKey = z.string().regex(/^[A-Za-z0-9]{20,}$/);
const TeamId = z.string().regex(/^\d+$/);
const ProjectId = z.string().regex(/^\d+$/);
const GetFileInput = z.object({
  fileKey: FileKey,
  /** Hard cap on the rendered document tree to avoid 5+ MB blobs in context. */
  maxNodes: z.number().int().min(10).max(50_000).default(2000),
});
const GetFileNodesInput = z.object({ fileKey: FileKey, ids: z.array(z.string().min(1)).min(1).max(100) });
const GetImageUrlsInput = z.object({
  fileKey: FileKey,
  ids: z.array(z.string().min(1)).min(1).max(100),
  format: z.enum(['png', 'svg', 'jpg', 'pdf']).default('png'),
  scale: z.number().min(0.01).max(4).default(1),
});
const GetCommentsInput = z.object({ fileKey: FileKey });
const ListTeamProjectsInput = z.object({ teamId: TeamId });
const ListProjectFilesInput = z.object({ projectId: ProjectId });
const HealthInput = z.object({});
const ExportTokensInput = z.object({
  fileKey: FileKey,
  format: z.enum(['css', 'scss', 'ts']).default('css'),
});

const http = createNamedHttpClient(SERVER_NAME, loadFigmaAuth());

const tools: ToolDefinition[] = [
  defineTool({
    name: 'figma.get_file',
    description:
      'Fetch a Figma file. Use `depth` (1-4) via get_file_nodes for surgical reads — entire document trees can be 5+ MB. `maxNodes` is a soft cap that surfaces a hint when crossed.',
    inputSchema: GetFileInput,
    async handle({ fileKey, maxNodes }, ctx) {
      const raw = await http.request<{ document?: { children?: readonly unknown[] } }>({
        path: `/v1/files/${fileKey}`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const nodeCount = countNodes(raw.document?.children ?? []);
      if (nodeCount > maxNodes) {
        return {
          ...raw,
          _warning: `document has ${nodeCount} nodes (> maxNodes=${maxNodes}). Prefer figma.get_file_nodes for surgical reads.`,
        };
      }
      return raw;
    },
  }),
  defineTool({
    name: 'figma.get_file_nodes',
    description: 'Fetch specific nodes from a Figma file by id.',
    inputSchema: GetFileNodesInput,
    async handle({ fileKey, ids }, ctx) {
      return http.request({
        path: `/v1/files/${fileKey}/nodes`,
        query: { ids: ids.join(',') },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'figma.get_image_urls',
    description: 'Get rendered image URLs for nodes.',
    inputSchema: GetImageUrlsInput,
    async handle({ fileKey, ids, format, scale }, ctx) {
      return http.request({
        path: `/v1/images/${fileKey}`,
        query: { ids: ids.join(','), format, scale },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'figma.get_comments',
    description: 'Fetch comments on a Figma file (author, message, resolved status, timestamps).',
    inputSchema: GetCommentsInput,
    async handle({ fileKey }, ctx) {
      const raw = await http.request<{ comments?: readonly RawFigmaComment[] }>({
        path: `/v1/files/${fileKey}/comments`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      return { comments: (raw.comments ?? []).map((c) => normaliseFigmaComment(c)) };
    },
  }),
  defineTool({
    name: 'figma.list_team_projects',
    description: 'List projects in a Figma team.',
    inputSchema: ListTeamProjectsInput,
    async handle({ teamId }, ctx) {
      return http.request({ path: `/v1/teams/${teamId}/projects`, correlationId: ctx.correlationId, tool: ctx.tool });
    },
  }),
  defineTool({
    name: 'figma.list_project_files',
    description: 'List files in a Figma project.',
    inputSchema: ListProjectFilesInput,
    async handle({ projectId }, ctx) {
      return http.request({
        path: `/v1/projects/${projectId}/files`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
    },
  }),
  defineTool({
    name: 'figma.export_tokens',
    description:
      'Export local variables from a Figma file as design tokens. Pulls `/v1/files/{fileKey}/variables/local`, maps the response onto a canonical Token shape, and emits CSS custom properties, SCSS variables, or a typed TS const.',
    inputSchema: ExportTokensInput,
    async handle({ fileKey, format }, ctx) {
      const raw = await http.request<RawVariablesResponse>({
        path: `/v1/files/${fileKey}/variables/local`,
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const tokens = mapFigmaVariables(raw);
      const content = emitForFormat(tokens, format);
      return { format, content, tokenCount: tokens.length };
    },
  }),
  defineTool({
    name: 'figma.health',
    description: 'Smoke-test the upstream + token: GET /v1/me. Returns { ok, durationMs } or throws.',
    inputSchema: HealthInput,
    async handle(_input, ctx) {
      const start = Date.now();
      await http.request({ path: '/v1/me', cache: false, correlationId: ctx.correlationId, tool: ctx.tool });
      return { ok: true, durationMs: Date.now() - start };
    },
  }),
  usageHistoryTool(SERVER_NAME),
  defineTool({
    name: 'figma.get_team_components',
    description:
      'AC63: Lista komponentów w bibliotece team (`/v1/teams/{team_id}/components`). Cursor-paginated; canonical shape z `key`, `name`, `description`, `containing_frame`. Wykrywa biblioteki design system per team.',
    inputSchema: z.object({
      teamId: TeamId,
      pageSize: z.number().int().min(1).max(1000).default(30),
      after: z.string().optional(),
    }),
    async handle({ teamId, pageSize, after }, ctx) {
      interface RawComponent {
        readonly key: string;
        readonly file_key?: string;
        readonly node_id?: string;
        readonly name?: string;
        readonly description?: string;
        readonly created_at?: string;
        readonly updated_at?: string;
        readonly containing_frame?: { readonly name?: string; readonly pageName?: string };
      }
      interface RawComponentsMeta {
        readonly meta?: {
          readonly components?: readonly RawComponent[];
          readonly cursor?: { readonly after?: string };
        };
      }
      const raw = await http.request<RawComponentsMeta>({
        path: `/v1/teams/${teamId}/components`,
        query: {
          page_size: pageSize,
          ...(after ? { after } : {}),
        },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const components = (raw.meta?.components ?? []).map((c) => ({
        key: c.key,
        ...(c.name ? { name: c.name } : {}),
        ...(c.description ? { description: c.description } : {}),
        ...(c.file_key ? { fileKey: c.file_key } : {}),
        ...(c.node_id ? { nodeId: c.node_id } : {}),
        ...(c.containing_frame?.name ? { frame: c.containing_frame.name } : {}),
        ...(c.containing_frame?.pageName ? { page: c.containing_frame.pageName } : {}),
        ...(c.updated_at ? { updatedAt: c.updated_at } : {}),
      }));
      return {
        components,
        count: components.length,
        ...(raw.meta?.cursor?.after ? { nextCursor: raw.meta.cursor.after } : {}),
      };
    },
  }),
  defineTool({
    name: 'figma.get_team_styles',
    description:
      'AC63: Lista design tokens w bibliotece team (`/v1/teams/{team_id}/styles`). Style typy: FILL (colors), TEXT (typography), EFFECT (shadows), GRID. Canonical shape z `key`, `name`, `styleType`, `description`.',
    inputSchema: z.object({
      teamId: TeamId,
      pageSize: z.number().int().min(1).max(1000).default(30),
      after: z.string().optional(),
    }),
    async handle({ teamId, pageSize, after }, ctx) {
      interface RawStyle {
        readonly key: string;
        readonly file_key?: string;
        readonly node_id?: string;
        readonly name?: string;
        readonly description?: string;
        readonly style_type?: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
        readonly updated_at?: string;
      }
      interface RawStylesMeta {
        readonly meta?: { readonly styles?: readonly RawStyle[]; readonly cursor?: { readonly after?: string } };
      }
      const raw = await http.request<RawStylesMeta>({
        path: `/v1/teams/${teamId}/styles`,
        query: {
          page_size: pageSize,
          ...(after ? { after } : {}),
        },
        correlationId: ctx.correlationId,
        tool: ctx.tool,
      });
      const styles = (raw.meta?.styles ?? []).map((s) => ({
        key: s.key,
        ...(s.style_type ? { styleType: s.style_type } : {}),
        ...(s.name ? { name: s.name } : {}),
        ...(s.description ? { description: s.description } : {}),
        ...(s.file_key ? { fileKey: s.file_key } : {}),
        ...(s.node_id ? { nodeId: s.node_id } : {}),
        ...(s.updated_at ? { updatedAt: s.updated_at } : {}),
      }));
      return {
        styles,
        count: styles.length,
        ...(raw.meta?.cursor?.after ? { nextCursor: raw.meta.cursor.after } : {}),
      };
    },
  }),
];

// ── prompts ────────────────────────────────────────────────────────────────

const prompts: PromptDefinition[] = [
  definePrompt({
    name: 'figma.export-tokens',
    description: 'Export design tokens (colors, typography, spacing) from a Figma file to structured JSON.',
    arguments: [{ name: 'fileKey', description: 'Figma file key (from URL)', required: true }],
    buildMessages: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `\`figma.export_tokens({ key: "${args['fileKey']}" })\`. Pogrupuj: colors (semantic + raw), typography (heading/body/caption), spacing (px scale). Output jako JSON gotowy do design-tokens spec.`,
        },
      },
    ],
  }),
];

// ── resources (MCP `resources/list` + `resources/read`) ──────────────────

const resources: ResourceDefinition[] = [
  defineMarkdownResource({
    uri: 'mcp-figma://docs/design-tokens-spec',
    name: 'Design tokens spec',
    description: 'Output shape for `figma.export_tokens` — colors / typography / spacing categories.',
    file: 'figma-design-tokens-spec.md',
  }),
];

// Re-exported dla konsumentów importujących moduł bez bootu (patrz `MCP_NO_BOOT` w `bootMcpServerIfEnabled`).
export { tools, prompts, resources };

await bootMcpServerIfEnabled({ name: SERVER_NAME, tools, prompts, resources });

// ── helpers ────────────────────────────────────────────────────────────────

interface FigmaNode {
  readonly children?: readonly FigmaNode[];
}

function countNodes(children: readonly unknown[], depth = 0): number {
  if (depth > 50) return 0; // pathological guard
  let total = children.length;
  for (const child of children) {
    const node = child as FigmaNode;
    if (node.children) total += countNodes(node.children, depth + 1);
  }
  return total;
}

interface RawFigmaComment {
  readonly id?: string;
  readonly user?: { readonly handle?: string };
  readonly message?: string;
  readonly created_at?: string;
  readonly resolved_at?: string | null;
  readonly parent_id?: string;
}

function normaliseFigmaComment(raw: RawFigmaComment): {
  id: string;
  author?: string;
  message: string;
  createdAt?: string;
  resolvedAt?: string;
  parentId?: string;
} {
  return {
    id: raw.id ?? '',
    ...(raw.user?.handle ? { author: raw.user.handle } : {}),
    message: raw.message ?? '',
    ...(raw.created_at ? { createdAt: raw.created_at } : {}),
    ...(raw.resolved_at ? { resolvedAt: raw.resolved_at } : {}),
    ...(raw.parent_id ? { parentId: raw.parent_id } : {}),
  };
}

// ── Figma Variables API → Token[] ──────────────────────────────────────────
//
// Variables API returns two collections: `variables` (one entry per token,
// keyed by id) and `variableCollections` (groups + mode metadata). Each
// variable has a `resolvedType` (COLOR / FLOAT / STRING / BOOLEAN) and a
// `valuesByMode` map keyed by modeId. We pick the default mode and project the
// raw value down to the string the emitters expect.

type FigmaResolvedType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';

interface RawFigmaColor {
  readonly r?: number;
  readonly g?: number;
  readonly b?: number;
  readonly a?: number;
}

interface RawFigmaVariable {
  readonly id?: string;
  readonly name?: string;
  readonly resolvedType?: FigmaResolvedType;
  readonly variableCollectionId?: string;
  readonly scopes?: readonly string[];
  readonly valuesByMode?: Readonly<Record<string, number | string | boolean | RawFigmaColor>>;
}

interface RawFigmaVariableCollection {
  readonly id?: string;
  readonly defaultModeId?: string;
}

interface RawVariablesResponse {
  readonly meta?: {
    readonly variables?: Readonly<Record<string, RawFigmaVariable>>;
    readonly variableCollections?: Readonly<Record<string, RawFigmaVariableCollection>>;
  };
}

function emitForFormat(tokens: readonly Token[], format: 'css' | 'scss' | 'ts'): string {
  switch (format) {
    case 'css': {
      return emitCss(tokens);
    }
    case 'scss': {
      return emitScss(tokens);
    }
    case 'ts': {
      return emitTs(tokens);
    }
  }
}

function mapFigmaVariables(raw: RawVariablesResponse): Token[] {
  const variables = raw.meta?.variables ?? {};
  const collections = raw.meta?.variableCollections ?? {};
  const tokens: Token[] = [];
  for (const v of Object.values(variables)) {
    if (!v.name || !v.resolvedType || !v.valuesByMode) continue;
    const collection = v.variableCollectionId ? collections[v.variableCollectionId] : undefined;
    const modeId = collection?.defaultModeId ?? Object.keys(v.valuesByMode)[0];
    if (!modeId) continue;
    const rawValue = v.valuesByMode[modeId];
    const value = renderValue(v.resolvedType, rawValue);
    if (value === undefined) continue;
    tokens.push({ name: v.name, value, kind: pickKind(v) });
  }
  return tokens;
}

function renderValue(
  type: FigmaResolvedType,
  value: number | string | boolean | RawFigmaColor | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  switch (type) {
    case 'COLOR': {
      return typeof value === 'object' ? rgbaToCss(value) : undefined;
    }
    case 'FLOAT': {
      return typeof value === 'number' ? `${value}px` : undefined;
    }
    case 'STRING': {
      return typeof value === 'string' ? value : undefined;
    }
    case 'BOOLEAN': {
      return typeof value === 'boolean' ? String(value) : undefined;
    }
  }
}

function rgbaToCss(c: RawFigmaColor): string {
  const r = Math.round((c.r ?? 0) * 255);
  const g = Math.round((c.g ?? 0) * 255);
  const b = Math.round((c.b ?? 0) * 255);
  const a = c.a ?? 1;
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

function pickKind(v: RawFigmaVariable): TokenKind {
  if (v.resolvedType === 'COLOR') return 'color';
  const scopes = v.scopes ?? [];
  if (scopes.includes('CORNER_RADIUS')) return 'radius';
  if (scopes.some((s) => s === 'EFFECT_FLOAT' || s === 'EFFECT_COLOR')) return 'shadow';
  if (scopes.some((s) => s === 'FONT_FAMILY' || s === 'FONT_SIZE' || s === 'FONT_WEIGHT' || s === 'LINE_HEIGHT')) {
    return 'typography';
  }
  return 'spacing';
}
