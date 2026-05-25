#!/usr/bin/env node
/**
 * extract-jira — deterministyczny pipeline danych Jira.
 *
 * Druga bramka równoległa do MCP. Ta sama warstwa shared (auth, http-client,
 * jira-reshape, field-registry, adf), ale bez agenta podejmującego decyzje —
 * parametry pochodzą z `extract.config.jira.json`, więc dla identycznego
 * configu i identycznego stanu upstreamu dostajesz bit-for-bit identyczny
 * output (modulo daty `updated`).
 *
 * Pipeline per snapshot:
 *   1. JQL search → wyczerpujący list wszystkich issue keys (paginowany).
 *   2. Per-issue: fetch z `fields=*all` + `expand=changelog,renderedFields,...`.
 *   3. Reshape przez `reshapeJiraIssue` (ten sam, którego używa mcp-jira).
 *   4. Pełna description ADF→MD bez 8 000-char cap (re-render z surowego ADF).
 *   5. Opcjonalnie comments / worklogs (osobne endpointy, paginowane).
 *   6. Write `<outputDir>/<snapshot>/<KEY>.json` + opcjonalnie `.md`.
 *   7. Manifest: `<outputDir>/<snapshot>/_manifest.json` z metadanymi runa.
 *
 * Run:
 *   node dist/extract-jira.js [path/to/extract.config.jira.json]
 *
 * Domyślny config path: `./extract.config.jira.json` (cwd).
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { adfToMarkdownSafe } from './shared/adf.js';
import { loadJiraAuth } from './shared/auth.js';
import {
  buildManifest,
  createScriptLogger,
  loadJsonConfig,
  renderFormatsSchema,
  runIfMain,
  snapshotNameSchema,
  writeManifest,
  writePipelineOutputs,
} from './shared/extract-runtime.js';
import { createJiraFieldRegistry, type FieldRegistry } from './shared/field-registry.js';
import { createNamedHttpClient, type HttpClient } from './shared/http-client.js';
import { reshapeJiraIssue, type CanonicalIssue } from './shared/jira-reshape.js';

const SCRIPT_NAME = 'extract-jira';

// ── Config schema ────────────────────────────────────────────────────────────

const SnapshotConfig = z.object({
  /** Nazwa snapshota — używana jako podkatalog w outputDir. Tylko `[a-z0-9-]`. */
  name: snapshotNameSchema,
  /** JQL identyfikujący zakres issue'ów. */
  jql: z.string().min(1),
  /** Górny limit liczby issue'ów per snapshot — chroni przed strzałem w nogę. */
  maxIssues: z.number().int().min(1).max(10_000).default(1000),
  /** Które dodatkowe payloady podpiąć. Domyślnie wszystkie — "wszystkie dane". */
  include: z
    .object({
      changelog: z.boolean().default(true),
      comments: z.boolean().default(true),
      worklog: z.boolean().default(true),
      attachments: z.boolean().default(true),
      renderedFields: z.boolean().default(true),
    })
    .default({
      changelog: true,
      comments: true,
      worklog: true,
      attachments: true,
      renderedFields: true,
    }),
  /** Które formaty zapisu wygenerować per issue. */
  render: renderFormatsSchema,
});
type Snapshot = z.infer<typeof SnapshotConfig>;

export const ExtractConfig = z.object({
  outputDir: z.string().min(1).default('./output/jira'),
  snapshots: z.array(SnapshotConfig).min(1),
});

// ── Surowe kształty Jira (lekkie typy, walidujemy tylko to, co używamy) ──────

export interface RawIssue {
  readonly id: string;
  readonly key: string;
  readonly self?: string;
  readonly fields?: Record<string, unknown>;
  readonly renderedFields?: Record<string, unknown>;
  readonly changelog?: { readonly histories?: readonly RawChangelogEntry[] };
}
interface RawChangelogEntry {
  readonly id?: string;
  readonly created?: string;
  readonly author?: { readonly displayName?: string; readonly accountId?: string };
  readonly items?: readonly { readonly field?: string; readonly fromString?: string; readonly toString?: string }[];
}
interface RawComment {
  readonly id?: string;
  readonly author?: { readonly displayName?: string; readonly accountId?: string };
  readonly created?: string;
  readonly updated?: string;
  readonly body?: unknown;
}
interface RawWorklog {
  readonly id?: string;
  readonly author?: { readonly displayName?: string; readonly accountId?: string };
  readonly started?: string;
  readonly timeSpent?: string;
  readonly timeSpentSeconds?: number;
  readonly comment?: unknown;
}
interface RawAttachment {
  readonly id?: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly created?: string;
  readonly author?: { readonly displayName?: string; readonly accountId?: string };
  readonly content?: string;
}
interface JqlSearchResponse {
  readonly issues: readonly RawIssue[];
  readonly nextPageToken?: string;
  readonly isLast?: boolean;
}

// ── Output shape ─────────────────────────────────────────────────────────────

export interface ExtractedIssue extends CanonicalIssue {
  /** Pełna description renderowana z ADF bez 8 000-char cap. */
  readonly descriptionMdFull?: string;
  readonly changelog?: readonly NormalisedChangelogEntry[];
  readonly comments?: readonly NormalisedComment[];
  readonly worklog?: readonly NormalisedWorklog[];
  readonly attachments?: readonly NormalisedAttachment[];
}
interface NormalisedChangelogEntry {
  readonly id?: string;
  readonly created?: string;
  readonly author?: string;
  readonly changes: readonly { readonly field: string; readonly from?: string; readonly to?: string }[];
}
interface NormalisedComment {
  readonly id?: string;
  readonly author?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly bodyMd?: string;
}
interface NormalisedWorklog {
  readonly id?: string;
  readonly author?: string;
  readonly started?: string;
  readonly timeSpent?: string;
  readonly timeSpentSeconds?: number;
  readonly commentMd?: string;
}
interface NormalisedAttachment {
  readonly id?: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly created?: string;
  readonly author?: string;
  readonly contentUrl?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = createScriptLogger(SCRIPT_NAME);

async function fetchAllIssueKeys(http: HttpClient, jql: string, max: number): Promise<readonly string[]> {
  const keys: string[] = [];
  let nextPageToken: string | undefined;
  const PAGE = 100;
  while (keys.length < max) {
    const remaining = max - keys.length;
    const maxResults = Math.min(PAGE, remaining);
    const resp: JqlSearchResponse = await http.request<JqlSearchResponse>({
      path: '/rest/api/3/search/jql',
      query: {
        jql,
        fields: 'key',
        maxResults,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    for (const issue of resp.issues) keys.push(issue.key);
    if (resp.isLast || !resp.nextPageToken) break;
    nextPageToken = resp.nextPageToken;
  }
  return keys;
}

async function fetchIssueFull(http: HttpClient, key: string, snapshot: Snapshot): Promise<RawIssue> {
  const expandParts: string[] = [];
  if (snapshot.include.changelog) expandParts.push('changelog');
  if (snapshot.include.renderedFields) expandParts.push('renderedFields');
  return http.request<RawIssue>({
    path: `/rest/api/3/issue/${key}`,
    query: {
      fields: '*all',
      ...(expandParts.length > 0 ? { expand: expandParts.join(',') } : {}),
    },
  });
}

async function fetchComments(http: HttpClient, key: string): Promise<readonly NormalisedComment[]> {
  const out: NormalisedComment[] = [];
  let startAt = 0;
  const PAGE = 100;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const resp = await http.request<{ comments?: readonly RawComment[]; isLast?: boolean; total?: number }>({
      path: `/rest/api/3/issue/${key}/comment`,
      query: { startAt, maxResults: PAGE },
    });
    for (const c of resp.comments ?? []) {
      out.push({
        id: c.id,
        author: c.author?.displayName ?? c.author?.accountId,
        created: c.created,
        updated: c.updated,
        bodyMd: adfToMarkdownSafe(c.body),
      });
    }
    if (resp.isLast === true || !resp.comments || resp.comments.length < PAGE) break;
    startAt += resp.comments.length;
  }
  return out;
}

async function fetchWorklogs(http: HttpClient, key: string): Promise<readonly NormalisedWorklog[]> {
  const resp = await http.request<{ worklogs?: readonly RawWorklog[] }>({
    path: `/rest/api/3/issue/${key}/worklog`,
    query: { maxResults: 1000 },
  });
  return (resp.worklogs ?? []).map((w) => ({
    id: w.id,
    author: w.author?.displayName ?? w.author?.accountId,
    started: w.started,
    timeSpent: w.timeSpent,
    timeSpentSeconds: w.timeSpentSeconds,
    commentMd: adfToMarkdownSafe(w.comment),
  }));
}

function normaliseChangelog(raw: RawIssue): readonly NormalisedChangelogEntry[] {
  const histories = raw.changelog?.histories ?? [];
  return histories.map((h) => ({
    id: h.id,
    created: h.created,
    author: h.author?.displayName ?? h.author?.accountId,
    changes: (h.items ?? []).map((i) => ({
      field: i.field ?? '',
      from: i.fromString ?? undefined,
      to: i.toString ?? undefined,
    })),
  }));
}

function normaliseAttachments(raw: RawIssue): readonly NormalisedAttachment[] {
  const attachments = (raw.fields?.['attachment'] as readonly RawAttachment[] | undefined) ?? [];
  return attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    created: a.created,
    author: a.author?.displayName ?? a.author?.accountId,
    contentUrl: a.content,
  }));
}

export function buildExtractedIssue(raw: RawIssue, registry: FieldRegistry, snapshot: Snapshot): ExtractedIssue {
  const base = reshapeJiraIssue(raw, registry);
  const fullDescriptionMd = adfToMarkdownSafe(raw.fields?.['description']);

  // Złóż deterministyczny shape — kolejność kluczy jest fixed.
  const out: ExtractedIssue = {
    ...base,
    ...(fullDescriptionMd && fullDescriptionMd !== base.descriptionMd ? { descriptionMdFull: fullDescriptionMd } : {}),
    ...(snapshot.include.changelog ? { changelog: normaliseChangelog(raw) } : {}),
    ...(snapshot.include.attachments ? { attachments: normaliseAttachments(raw) } : {}),
  };
  return out;
}

export function renderIssueMarkdown(issue: ExtractedIssue): string {
  const lines: string[] = [];
  lines.push(`# ${issue.key} — ${issue.summary ?? '(no summary)'}`);
  lines.push('');
  lines.push(`- **Status**: ${issue.status?.name ?? '—'}`);
  lines.push(`- **Type**: ${issue.issueType?.name ?? '—'}`);
  lines.push(`- **Priority**: ${issue.priority?.name ?? '—'}`);
  lines.push(`- **Assignee**: ${issue.assignee?.displayName ?? '—'}`);
  lines.push(`- **Reporter**: ${issue.reporter?.displayName ?? '—'}`);
  lines.push(`- **Created**: ${issue.created ?? '—'}`);
  lines.push(`- **Updated**: ${issue.updated ?? '—'}`);
  if (issue.labels && issue.labels.length > 0) lines.push(`- **Labels**: ${issue.labels.join(', ')}`);
  lines.push('');

  const desc = issue.descriptionMdFull ?? issue.descriptionMd;
  if (desc) {
    lines.push('## Description');
    lines.push('');
    lines.push(desc);
    lines.push('');
  }

  if (issue.customFields && issue.customFields.length > 0) {
    lines.push('## Custom fields');
    lines.push('');
    for (const cf of issue.customFields) {
      lines.push(`- **${cf.name}** (\`${cf.id}\`): ${formatFieldValue(cf.value)}`);
    }
    lines.push('');
  }

  if (issue.comments && issue.comments.length > 0) {
    lines.push('## Comments');
    lines.push('');
    for (const c of issue.comments) {
      lines.push(`### ${c.author ?? 'unknown'} — ${c.created ?? '—'}`);
      lines.push('');
      if (c.bodyMd) lines.push(c.bodyMd);
      lines.push('');
    }
  }

  if (issue.worklog && issue.worklog.length > 0) {
    lines.push('## Worklog');
    lines.push('');
    for (const w of issue.worklog) {
      lines.push(`- ${w.started ?? '—'} · ${w.author ?? 'unknown'} · ${w.timeSpent ?? '—'}`);
      if (w.commentMd) lines.push(`  > ${w.commentMd.replaceAll('\n', '\n  > ')}`);
    }
    lines.push('');
  }

  if (issue.changelog && issue.changelog.length > 0) {
    lines.push('## Changelog');
    lines.push('');
    for (const h of issue.changelog) {
      lines.push(`### ${h.created ?? '—'} — ${h.author ?? 'unknown'}`);
      for (const ch of h.changes) {
        lines.push(`- **${ch.field}**: \`${ch.from ?? '∅'}\` → \`${ch.to ?? '∅'}\``);
      }
      lines.push('');
    }
  }

  if (issue.attachments && issue.attachments.length > 0) {
    lines.push('## Attachments');
    lines.push('');
    for (const a of issue.attachments) {
      lines.push(`- **${a.filename ?? '?'}** (${a.mimeType ?? '?'}, ${a.size ?? '?'} B) — ${a.contentUrl ?? ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

async function writeIssueOutputs(
  baseDir: string,
  issue: ExtractedIssue,
  formats: readonly ('json' | 'markdown')[],
): Promise<void> {
  await writePipelineOutputs({
    dir: baseDir,
    basename: issue.key,
    data: issue,
    markdown: renderIssueMarkdown(issue),
    formats,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = resolve(process.argv[2] ?? './extract.config.jira.json');
  log(`config: ${configPath}`);
  const config = await loadJsonConfig(configPath, ExtractConfig);

  const http = createNamedHttpClient(SCRIPT_NAME, loadJiraAuth());
  const registry = createJiraFieldRegistry(http);
  const outputRoot = resolve(dirname(configPath), config.outputDir);

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let totalIssues = 0;

  for (const snapshot of config.snapshots) {
    log(`snapshot "${snapshot.name}": ${snapshot.jql}`);
    const snapshotDir = join(outputRoot, snapshot.name);
    await mkdir(snapshotDir, { recursive: true });

    const keys = await fetchAllIssueKeys(http, snapshot.jql, snapshot.maxIssues);
    log(`  resolved ${keys.length} issue key(s)`);

    const written: string[] = [];
    for (const key of keys) {
      const raw = await fetchIssueFull(http, key, snapshot);
      const built = buildExtractedIssue(raw, registry, snapshot);

      const mutableExtras: { -readonly [K in keyof ExtractedIssue]?: ExtractedIssue[K] } = {};
      if (snapshot.include.comments) mutableExtras.comments = await fetchComments(http, key);
      if (snapshot.include.worklog) mutableExtras.worklog = await fetchWorklogs(http, key);

      const finalIssue: ExtractedIssue = { ...built, ...mutableExtras };
      await writeIssueOutputs(snapshotDir, finalIssue, snapshot.render);
      written.push(finalIssue.key);
      totalIssues += 1;
    }

    await writeManifest(
      snapshotDir,
      buildManifest(SCRIPT_NAME, startedAt, snapshot, {
        jql: snapshot.jql,
        issueCount: written.length,
        issueKeys: written,
        include: snapshot.include,
      }),
    );
    log(`  wrote ${written.length} issue(s) → ${snapshotDir}`);
  }

  const durationMs = Date.now() - startMs;
  log(`done — ${totalIssues} issue(s) across ${config.snapshots.length} snapshot(s) in ${durationMs}ms`);
}

await runIfMain(SCRIPT_NAME, import.meta.url, main);
