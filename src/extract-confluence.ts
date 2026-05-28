#!/usr/bin/env node
/**
 * extract-confluence — deterministyczny pipeline danych Confluence.
 *
 * Druga bramka równoległa do MCP. Ta sama warstwa shared (auth, http-client,
 * confluence-reshape, adf), ale bez agenta — parametry pochodzą z
 * `extract.config.confluence.json`.
 *
 * Snapshot ma jeden z 3 trybów:
 *   - `type: "page"`  → jedna strona po `pageId`.
 *   - `type: "tree"`  → strona + descendants (BFS, do `depth` poziomów).
 *   - `type: "label"` → wszystkie strony z labelem `label` (opcjonalnie w `space`).
 *
 * Per strona ściągamy:
 *   - Body (ADF → Markdown, FULL, bez 5 000-char cap).
 *   - Comments (footer + inline, ADF → Markdown).
 *   - Attachments (lista metadanych, nie pliki).
 *   - Labels.
 *   - Ancestors (path do roota).
 *
 * Output: `<outputDir>/<snapshot>/<pageId>.json` (+ `.md` jeśli render zawiera markdown)
 *   plus `_manifest.json` z metadanymi runa.
 *
 * Run:
 *   node dist/extract-confluence.js [path/to/extract.config.confluence.json]
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { adfToMarkdownSafe } from './shared/adf.js';
import { loadConfluenceAuth } from './shared/auth.js';
import {
  buildManifest,
  createScriptLogger,
  loadJsonConfig,
  parseCursorFromLink,
  renderFormatsSchema,
  runIfMain,
  snapshotNameSchema,
  writeManifest,
  writePipelineOutputs,
} from './shared/extract-runtime.js';
import { createNamedHttpClient, type HttpClient } from './shared/http-client.js';

const SCRIPT_NAME = 'extract-confluence';

// ── Config ───────────────────────────────────────────────────────────────────

const PageSnapshot = z.object({
  name: snapshotNameSchema,
  type: z.literal('page'),
  pageId: z.string().regex(/^\d+$/),
  render: renderFormatsSchema,
});
const TreeSnapshot = z.object({
  name: snapshotNameSchema,
  type: z.literal('tree'),
  rootPageId: z.string().regex(/^\d+$/),
  /** Maksymalna głębokość BFS (1 = sam root, 2 = root + dzieci, …). */
  depth: z.number().int().min(1).max(10).default(3),
  maxPages: z.number().int().min(1).max(5000).default(500),
  render: renderFormatsSchema,
});
const LabelSnapshot = z.object({
  name: snapshotNameSchema,
  type: z.literal('label'),
  label: z.string().min(1),
  space: z.string().optional(),
  maxPages: z.number().int().min(1).max(5000).default(500),
  render: renderFormatsSchema,
});

const SnapshotConfig = z.discriminatedUnion('type', [PageSnapshot, TreeSnapshot, LabelSnapshot]);
type Snapshot = z.infer<typeof SnapshotConfig>;

export const ExtractConfig = z.object({
  outputDir: z.string().min(1).default('./output/confluence'),
  snapshots: z.array(SnapshotConfig).min(1),
});

// ── Surowe kształty Confluence ───────────────────────────────────────────────

interface RawPageBody {
  readonly value?: unknown;
  readonly representation?: string;
}
interface RawPage {
  readonly id: string;
  readonly title?: string;
  readonly spaceId?: string;
  readonly status?: string;
  readonly authorId?: string;
  readonly createdAt?: string;
  readonly version?: { readonly number?: number };
  readonly body?: { readonly atlas_doc_format?: RawPageBody };
  readonly _links?: { readonly webui?: string; readonly base?: string };
}
interface RawComment {
  readonly id?: string;
  readonly title?: string;
  readonly createdAt?: string;
  readonly version?: { readonly authorId?: string; readonly number?: number };
  readonly body?: { readonly atlas_doc_format?: RawPageBody };
}
interface RawAttachment {
  readonly id?: string;
  readonly title?: string;
  readonly mediaType?: string;
  readonly fileSize?: number;
  readonly createdAt?: string;
  readonly version?: { readonly number?: number };
  readonly downloadLink?: string;
}
interface RawLabel {
  readonly id?: string;
  readonly name?: string;
  readonly prefix?: string;
}
interface RawAncestor {
  readonly id?: string;
  readonly title?: string;
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface ExtractedPage {
  readonly id: string;
  readonly title?: string;
  readonly spaceId?: string;
  readonly status?: string;
  readonly version?: number;
  readonly authorId?: string;
  readonly createdAt?: string;
  readonly url?: string;
  readonly bodyMd?: string;
  readonly labels: readonly string[];
  readonly ancestors: readonly { id: string; title?: string }[];
  readonly comments: readonly NormalisedComment[];
  readonly attachments: readonly NormalisedAttachment[];
  readonly childPageIds: readonly string[];
}
interface NormalisedComment {
  readonly id?: string;
  readonly title?: string;
  readonly authorId?: string;
  readonly createdAt?: string;
  readonly version?: number;
  readonly bodyMd?: string;
}
interface NormalisedAttachment {
  readonly id?: string;
  readonly title?: string;
  readonly mediaType?: string;
  readonly fileSize?: number;
  readonly createdAt?: string;
  readonly version?: number;
  readonly downloadLink?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = createScriptLogger(SCRIPT_NAME);

async function fetchPage(http: HttpClient, pageId: string): Promise<RawPage> {
  return http.request<RawPage>({
    path: `/wiki/api/v2/pages/${pageId}`,
    query: { 'body-format': 'atlas_doc_format' },
  });
}

async function fetchChildren(http: HttpClient, pageId: string): Promise<readonly string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const resp = await http.request<{
      results?: readonly { id?: string }[];
      _links?: { next?: string };
    }>({
      path: `/wiki/api/v2/pages/${pageId}/children`,
      query: { limit: 250, ...(cursor ? { cursor } : {}) },
    });
    for (const r of resp.results ?? []) {
      if (r.id) out.push(r.id);
    }
    const nextCursor = parseCursorFromLink(resp._links?.next);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return out;
}

async function fetchAncestors(http: HttpClient, pageId: string): Promise<readonly { id: string; title?: string }[]> {
  const resp = await http.request<{ results?: readonly RawAncestor[] }>({
    path: `/wiki/api/v2/pages/${pageId}/ancestors`,
  });
  return (resp.results ?? [])
    .filter((a): a is RawAncestor & { id: string } => typeof a.id === 'string')
    .map((a) => ({ id: a.id, title: a.title }));
}

async function fetchLabels(http: HttpClient, pageId: string): Promise<readonly string[]> {
  const resp = await http.request<{ results?: readonly RawLabel[] }>({
    path: `/wiki/api/v2/pages/${pageId}/labels`,
    query: { limit: 250 },
  });
  return (resp.results ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
}

async function fetchComments(http: HttpClient, pageId: string): Promise<readonly NormalisedComment[]> {
  const out: NormalisedComment[] = [];
  for (const endpoint of ['footer-comments', 'inline-comments'] as const) {
    let cursor: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const resp = await http.request<{
        results?: readonly RawComment[];
        _links?: { next?: string };
      }>({
        path: `/wiki/api/v2/pages/${pageId}/${endpoint}`,
        query: { 'body-format': 'atlas_doc_format', limit: 100, ...(cursor ? { cursor } : {}) },
      });
      for (const c of resp.results ?? []) {
        out.push({
          id: c.id,
          title: c.title,
          authorId: c.version?.authorId,
          createdAt: c.createdAt,
          version: c.version?.number,
          bodyMd: adfToMarkdownSafe(c.body?.atlas_doc_format?.value),
        });
      }
      const next = resp._links?.next;
      if (!next) break;
      const m = /[?&]cursor=([^&]+)/.exec(next);
      const cursorValue = m?.[1];
      if (!cursorValue) break;
      cursor = decodeURIComponent(cursorValue);
    }
  }
  return out;
}

async function fetchAttachments(http: HttpClient, pageId: string): Promise<readonly NormalisedAttachment[]> {
  const resp = await http.request<{ results?: readonly RawAttachment[] }>({
    path: `/wiki/api/v2/pages/${pageId}/attachments`,
    query: { limit: 250 },
  });
  return (resp.results ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    mediaType: a.mediaType,
    fileSize: a.fileSize,
    createdAt: a.createdAt,
    version: a.version?.number,
    downloadLink: a.downloadLink,
  }));
}

async function fetchPagesByLabel(
  http: HttpClient,
  label: string,
  space: string | undefined,
  max: number,
): Promise<readonly string[]> {
  const cqlBits = [`label = "${label}"`];
  if (space) cqlBits.push(`space = "${space}"`);
  const cql = cqlBits.join(' AND ') + ' AND type = page';

  const out: string[] = [];
  let cursor: string | undefined;
  while (out.length < max) {
    const limit = Math.min(50, max - out.length);
    const resp = await http.request<{
      results?: readonly { content?: { id?: string; type?: string } }[];
      _links?: { next?: string };
    }>({
      path: '/wiki/rest/api/search',
      query: { cql, limit, ...(cursor ? { cursor } : {}) },
    });
    for (const r of resp.results ?? []) {
      if (r.content?.id && r.content.type === 'page') out.push(r.content.id);
    }
    const nextCursor = parseCursorFromLink(resp._links?.next);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return out;
}

async function buildExtractedPage(http: HttpClient, pageId: string): Promise<ExtractedPage> {
  const [raw, labels, ancestors, comments, attachments, childIds] = await Promise.all([
    fetchPage(http, pageId),
    fetchLabels(http, pageId),
    fetchAncestors(http, pageId),
    fetchComments(http, pageId),
    fetchAttachments(http, pageId),
    fetchChildren(http, pageId),
  ]);

  return {
    id: raw.id,
    title: raw.title,
    spaceId: raw.spaceId,
    status: raw.status,
    version: raw.version?.number,
    authorId: raw.authorId,
    createdAt: raw.createdAt,
    url: raw._links?.webui ? `${raw._links.base ?? ''}${raw._links.webui}` : undefined,
    bodyMd: adfToMarkdownSafe(raw.body?.atlas_doc_format?.value),
    labels,
    ancestors,
    comments,
    attachments,
    childPageIds: childIds,
  };
}

export function renderPageMarkdown(page: ExtractedPage): string {
  const lines: string[] = [];
  lines.push(`# ${page.title ?? `Page ${page.id}`}`);
  lines.push('');
  lines.push(`- **ID**: \`${page.id}\``);
  if (page.spaceId) lines.push(`- **Space**: \`${page.spaceId}\``);
  lines.push(`- **Status**: ${page.status ?? '—'}`);
  lines.push(`- **Version**: ${page.version ?? '—'}`);
  lines.push(`- **Created**: ${page.createdAt ?? '—'}`);
  if (page.url) lines.push(`- **URL**: ${page.url}`);
  if (page.labels.length > 0) lines.push(`- **Labels**: ${page.labels.join(', ')}`);
  if (page.ancestors.length > 0) {
    lines.push(`- **Path**: ${page.ancestors.map((a) => a.title ?? a.id).join(' › ')}`);
  }
  lines.push('');

  if (page.bodyMd) {
    lines.push('## Body');
    lines.push('');
    lines.push(page.bodyMd);
    lines.push('');
  }

  if (page.comments.length > 0) {
    lines.push('## Comments');
    lines.push('');
    for (const c of page.comments) {
      lines.push(`### ${c.title ?? '(no title)'} — ${c.createdAt ?? '—'}`);
      if (c.bodyMd) {
        lines.push('');
        lines.push(c.bodyMd);
      }
      lines.push('');
    }
  }

  if (page.attachments.length > 0) {
    lines.push('## Attachments');
    lines.push('');
    for (const a of page.attachments) {
      lines.push(`- **${a.title ?? '?'}** (${a.mediaType ?? '?'}, ${a.fileSize ?? '?'} B)`);
    }
    lines.push('');
  }

  if (page.childPageIds.length > 0) {
    lines.push('## Children');
    lines.push('');
    for (const id of page.childPageIds) {
      lines.push(`- \`${id}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function writePageOutputs(
  baseDir: string,
  page: ExtractedPage,
  formats: readonly ('json' | 'markdown')[],
): Promise<void> {
  await writePipelineOutputs({
    dir: baseDir,
    basename: page.id,
    data: page,
    markdown: renderPageMarkdown(page),
    formats,
  });
}

// ── Resolvers per snapshot type ──────────────────────────────────────────────

async function resolvePageIds(http: HttpClient, snapshot: Snapshot): Promise<readonly string[]> {
  if (snapshot.type === 'page') return [snapshot.pageId];
  if (snapshot.type === 'label') return fetchPagesByLabel(http, snapshot.label, snapshot.space, snapshot.maxPages);

  // tree — BFS od rootPageId do snapshot.depth poziomów
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier: string[] = [snapshot.rootPageId];
  for (let level = 0; level < snapshot.depth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      if (order.length >= snapshot.maxPages) return order;
      if (level + 1 < snapshot.depth) {
        const children = await fetchChildren(http, id);
        for (const c of children) if (!seen.has(c)) next.push(c);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return order;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = resolve(process.argv[2] ?? './extract.config.confluence.json');
  log(`config: ${configPath}`);
  const config = await loadJsonConfig(configPath, ExtractConfig);

  const http = createNamedHttpClient(SCRIPT_NAME, loadConfluenceAuth());

  const outputRoot = resolve(dirname(configPath), config.outputDir);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let totalPages = 0;

  for (const snapshot of config.snapshots) {
    log(`snapshot "${snapshot.name}" (${snapshot.type})`);
    const snapshotDir = join(outputRoot, snapshot.name);
    await mkdir(snapshotDir, { recursive: true });

    const pageIds = await resolvePageIds(http, snapshot);
    log(`  resolved ${pageIds.length} page id(s)`);

    const written: string[] = [];
    for (const pageId of pageIds) {
      const page = await buildExtractedPage(http, pageId);
      await writePageOutputs(snapshotDir, page, snapshot.render);
      written.push(page.id);
      totalPages += 1;
    }

    await writeManifest(
      snapshotDir,
      buildManifest(SCRIPT_NAME, startedAt, snapshot, {
        type: snapshot.type,
        pageCount: written.length,
        pageIds: written,
      }),
    );
    log(`  wrote ${written.length} page(s) → ${snapshotDir}`);
  }

  const durationMs = Date.now() - startMs;
  log(`done — ${totalPages} page(s) across ${config.snapshots.length} snapshot(s) in ${durationMs}ms`);
}

await runIfMain(SCRIPT_NAME, import.meta.url, main);
