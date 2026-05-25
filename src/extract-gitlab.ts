#!/usr/bin/env node
/**
 * extract-gitlab — deterministyczny pipeline danych GitLab.
 *
 * Druga bramka równoległa do MCP. Ta sama warstwa shared (auth,
 * http-client, gitlab-reshape), ale bez agenta — parametry pochodzą z
 * `extract.config.gitlab.json`.
 *
 * Snapshot ma jeden z 3 typów:
 *   - `type: "issues"`    → wszystkie issues w projekcie po filtrach (state/labels) + notes
 *   - `type: "mrs"`       → wszystkie MR-y po filtrach (state) + notes + changes summary
 *   - `type: "pipelines"` → ostatnie N pipeline'ów + lista jobów per pipeline
 *
 * Output: `<outputDir>/<snapshot>/<resource-id>.json` (+ `.md` jeśli render includes markdown)
 *   plus `_manifest.json` z metadanymi runa.
 *
 * Run:
 *   node dist/extract-gitlab.js [path/to/extract.config.gitlab.json]
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { loadGitLabAuth } from './shared/auth.js';
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
import {
  reshapeGitLabIssue,
  reshapeGitLabMr,
  reshapeGitLabPipeline,
  type CanonicalGitLabIssue,
  type CanonicalMr,
  type CanonicalPipeline,
} from './shared/gitlab-reshape.js';
import { createNamedHttpClient, type HttpClient } from './shared/http-client.js';

const SCRIPT_NAME = 'extract-gitlab';

// ── Config ───────────────────────────────────────────────────────────────────

const baseSnapshot = {
  name: snapshotNameSchema,
  /** GitLab project ID (number) lub `group/subgroup/project` (path). */
  projectId: z.string().min(1),
  render: renderFormatsSchema,
} as const;

const IssuesSnapshot = z.object({
  ...baseSnapshot,
  type: z.literal('issues'),
  state: z.enum(['opened', 'closed', 'all']).default('all'),
  labels: z.string().optional(),
  maxItems: z.number().int().min(1).max(10_000).default(500),
  includeNotes: z.boolean().default(true),
});
const MrsSnapshot = z.object({
  ...baseSnapshot,
  type: z.literal('mrs'),
  state: z.enum(['opened', 'closed', 'merged', 'locked', 'all']).default('all'),
  maxItems: z.number().int().min(1).max(10_000).default(500),
  includeNotes: z.boolean().default(true),
  includeChanges: z.boolean().default(false),
});
const PipelinesSnapshot = z.object({
  ...baseSnapshot,
  type: z.literal('pipelines'),
  ref: z.string().optional(),
  maxItems: z.number().int().min(1).max(2000).default(100),
  includeJobs: z.boolean().default(true),
});

const SnapshotConfig = z.discriminatedUnion('type', [IssuesSnapshot, MrsSnapshot, PipelinesSnapshot]);

export const ExtractConfig = z.object({
  outputDir: z.string().min(1).default('./output/gitlab'),
  snapshots: z.array(SnapshotConfig).min(1),
});

// ── Raw shapes (lekkie typy, tylko to czego używamy) ─────────────────────────

interface RawNote {
  readonly id?: number;
  readonly system?: boolean;
  readonly author?: { readonly username?: string };
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly body?: string;
}
interface RawJob {
  readonly id?: number;
  readonly name?: string;
  readonly stage?: string;
  readonly status?: string;
  readonly created_at?: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly duration?: number | null;
  readonly web_url?: string;
}
interface RawMrChange {
  readonly old_path?: string;
  readonly new_path?: string;
  readonly new_file?: boolean;
  readonly renamed_file?: boolean;
  readonly deleted_file?: boolean;
}
interface RawMrChanges {
  readonly changes?: readonly RawMrChange[];
}

// ── Output ───────────────────────────────────────────────────────────────────

interface NormalisedNote {
  readonly id?: number;
  readonly author?: string;
  readonly system: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly body?: string;
}
interface NormalisedJob {
  readonly id?: number;
  readonly name?: string;
  readonly stage?: string;
  readonly status?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationSec?: number;
  readonly url?: string;
}
interface NormalisedChange {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly newFile: boolean;
  readonly renamedFile: boolean;
  readonly deletedFile: boolean;
}

export interface ExtractedIssue extends CanonicalGitLabIssue {
  readonly notes?: readonly NormalisedNote[];
}
export interface ExtractedMr extends CanonicalMr {
  readonly notes?: readonly NormalisedNote[];
  readonly changes?: readonly NormalisedChange[];
}
export interface ExtractedPipeline extends CanonicalPipeline {
  readonly jobs?: readonly NormalisedJob[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = createScriptLogger(SCRIPT_NAME);

function encodeProject(projectId: string): string {
  return /^\d+$/.test(projectId) ? projectId : encodeURIComponent(projectId);
}

async function listAll<T>(
  http: HttpClient,
  path: string,
  baseQuery: Record<string, string | number | boolean | undefined>,
  max: number,
): Promise<readonly T[]> {
  const out: T[] = [];
  let page = 1;
  const PER_PAGE = 100;
  while (out.length < max) {
    const limit = Math.min(PER_PAGE, max - out.length);
    const items = await http.request<readonly T[]>({
      path,
      query: { ...baseQuery, per_page: limit, page },
    });
    if (items.length === 0) break;
    for (const it of items) out.push(it);
    if (items.length < limit) break;
    page += 1;
  }
  return out;
}

function normaliseNote(n: RawNote): NormalisedNote {
  return {
    id: n.id,
    author: n.author?.username,
    system: n.system === true,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    body: n.body,
  };
}
function normaliseJob(j: RawJob): NormalisedJob {
  return {
    id: j.id,
    name: j.name,
    stage: j.stage,
    status: j.status,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
    durationSec: typeof j.duration === 'number' ? j.duration : undefined,
    url: j.web_url,
  };
}
function normaliseChange(c: RawMrChange): NormalisedChange {
  return {
    oldPath: c.old_path,
    newPath: c.new_path,
    newFile: c.new_file === true,
    renamedFile: c.renamed_file === true,
    deletedFile: c.deleted_file === true,
  };
}

// ── Renderers ────────────────────────────────────────────────────────────────

export function renderIssueMarkdown(issue: ExtractedIssue): string {
  const lines: string[] = [];
  lines.push(`# !${issue.iid} — ${issue.title}`);
  lines.push('');
  lines.push(`- **State**: ${issue.state}`);
  if (issue.author) lines.push(`- **Author**: ${issue.author}`);
  if (issue.assignees && issue.assignees.length > 0) lines.push(`- **Assignees**: ${issue.assignees.join(', ')}`);
  if (issue.labels && issue.labels.length > 0) lines.push(`- **Labels**: ${issue.labels.join(', ')}`);
  if (issue.milestone) lines.push(`- **Milestone**: ${issue.milestone}`);
  if (issue.createdAt) lines.push(`- **Created**: ${issue.createdAt}`);
  if (issue.updatedAt) lines.push(`- **Updated**: ${issue.updatedAt}`);
  if (issue.closedAt) lines.push(`- **Closed**: ${issue.closedAt}`);
  if (issue.url) lines.push(`- **URL**: ${issue.url}`);
  lines.push('');

  if (issue.description) {
    lines.push('## Description');
    lines.push('');
    lines.push(issue.description);
    lines.push('');
  }

  if (issue.notes && issue.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const n of issue.notes) {
      const sys = n.system ? ' [system]' : '';
      lines.push(`### ${n.author ?? 'unknown'}${sys} — ${n.createdAt ?? '—'}`);
      lines.push('');
      if (n.body) lines.push(n.body);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function renderMrMarkdown(mr: ExtractedMr): string {
  const lines: string[] = [];
  lines.push(`# !${mr.iid} — ${mr.title}`);
  lines.push('');
  lines.push(`- **State**: ${mr.state}`);
  if (mr.draft === true) lines.push(`- **Draft**: yes`);
  if (mr.author) lines.push(`- **Author**: ${mr.author}`);
  if (mr.sourceBranch && mr.targetBranch) lines.push(`- **Branches**: \`${mr.sourceBranch}\` → \`${mr.targetBranch}\``);
  if (mr.mergeStatus) lines.push(`- **Merge status**: ${mr.mergeStatus}`);
  if (mr.hasConflicts === true) lines.push(`- **Conflicts**: yes`);
  if (mr.assignees && mr.assignees.length > 0) lines.push(`- **Assignees**: ${mr.assignees.join(', ')}`);
  if (mr.reviewers && mr.reviewers.length > 0) lines.push(`- **Reviewers**: ${mr.reviewers.join(', ')}`);
  if (mr.labels && mr.labels.length > 0) lines.push(`- **Labels**: ${mr.labels.join(', ')}`);
  if (mr.createdAt) lines.push(`- **Created**: ${mr.createdAt}`);
  if (mr.updatedAt) lines.push(`- **Updated**: ${mr.updatedAt}`);
  if (mr.mergedAt) lines.push(`- **Merged**: ${mr.mergedAt}`);
  if (mr.url) lines.push(`- **URL**: ${mr.url}`);
  lines.push('');

  if (mr.description) {
    lines.push('## Description');
    lines.push('');
    lines.push(mr.description);
    lines.push('');
  }

  if (mr.changes && mr.changes.length > 0) {
    lines.push('## Changed files');
    lines.push('');
    for (const c of mr.changes) {
      const marker = c.newFile ? '+' : c.deletedFile ? '-' : c.renamedFile ? 'R' : 'M';
      const path = c.newPath ?? c.oldPath ?? '?';
      lines.push(`- \`${marker}\` ${path}`);
    }
    lines.push('');
  }

  if (mr.notes && mr.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const n of mr.notes) {
      const sys = n.system ? ' [system]' : '';
      lines.push(`### ${n.author ?? 'unknown'}${sys} — ${n.createdAt ?? '—'}`);
      lines.push('');
      if (n.body) lines.push(n.body);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function renderPipelineMarkdown(pipeline: ExtractedPipeline): string {
  const lines: string[] = [];
  lines.push(`# Pipeline #${pipeline.id} — ${pipeline.status}`);
  lines.push('');
  if (pipeline.ref) lines.push(`- **Ref**: \`${pipeline.ref}\``);
  if (pipeline.sha) lines.push(`- **SHA**: \`${pipeline.sha}\``);
  if (pipeline.source) lines.push(`- **Source**: ${pipeline.source}`);
  if (pipeline.createdAt) lines.push(`- **Created**: ${pipeline.createdAt}`);
  if (pipeline.updatedAt) lines.push(`- **Updated**: ${pipeline.updatedAt}`);
  if (pipeline.url) lines.push(`- **URL**: ${pipeline.url}`);
  lines.push('');

  if (pipeline.jobs && pipeline.jobs.length > 0) {
    lines.push('## Jobs');
    lines.push('');
    for (const j of pipeline.jobs) {
      const dur = typeof j.durationSec === 'number' ? ` (${j.durationSec.toFixed(1)}s)` : '';
      lines.push(`- \`${j.status ?? '?'}\` **${j.name ?? '?'}** [${j.stage ?? '?'}]${dur}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Output writers ───────────────────────────────────────────────────────────

async function writeOutputs(
  baseDir: string,
  id: string,
  data: unknown,
  markdown: string,
  formats: readonly ('json' | 'markdown')[],
): Promise<void> {
  await writePipelineOutputs({ dir: baseDir, basename: id, data, markdown, formats });
}

// ── Per-type processors ──────────────────────────────────────────────────────

async function processIssues(
  http: HttpClient,
  snapshot: z.infer<typeof IssuesSnapshot>,
  snapshotDir: string,
): Promise<readonly string[]> {
  const project = encodeProject(snapshot.projectId);
  const raw = await listAll<Parameters<typeof reshapeGitLabIssue>[0]>(
    http,
    `/projects/${project}/issues`,
    {
      state: snapshot.state === 'all' ? undefined : snapshot.state,
      ...(snapshot.labels ? { labels: snapshot.labels } : {}),
      order_by: 'updated_at',
      sort: 'desc',
    },
    snapshot.maxItems,
  );

  const written: string[] = [];
  for (const rawIssue of raw) {
    const base = reshapeGitLabIssue(rawIssue);
    const notes = snapshot.includeNotes
      ? (await listAll<RawNote>(http, `/projects/${project}/issues/${base.iid}/notes`, { sort: 'asc' }, 1000)).map(
          normaliseNote,
        )
      : undefined;
    const issue: ExtractedIssue = { ...base, ...(notes ? { notes } : {}) };
    const id = `issue-${issue.iid}`;
    await writeOutputs(snapshotDir, id, issue, renderIssueMarkdown(issue), snapshot.render);
    written.push(id);
  }
  return written;
}

async function processMrs(
  http: HttpClient,
  snapshot: z.infer<typeof MrsSnapshot>,
  snapshotDir: string,
): Promise<readonly string[]> {
  const project = encodeProject(snapshot.projectId);
  const raw = await listAll<Parameters<typeof reshapeGitLabMr>[0]>(
    http,
    `/projects/${project}/merge_requests`,
    {
      state: snapshot.state === 'all' ? undefined : snapshot.state,
      order_by: 'updated_at',
      sort: 'desc',
    },
    snapshot.maxItems,
  );

  const written: string[] = [];
  for (const rawMr of raw) {
    const base = reshapeGitLabMr(rawMr);
    const notes = snapshot.includeNotes
      ? (
          await listAll<RawNote>(http, `/projects/${project}/merge_requests/${base.iid}/notes`, { sort: 'asc' }, 1000)
        ).map(normaliseNote)
      : undefined;
    const changes = snapshot.includeChanges
      ? (
          await http.request<RawMrChanges>({
            path: `/projects/${project}/merge_requests/${base.iid}/changes`,
          })
        ).changes?.map(normaliseChange)
      : undefined;

    const mr: ExtractedMr = {
      ...base,
      ...(notes ? { notes } : {}),
      ...(changes && changes.length > 0 ? { changes } : {}),
    };
    const id = `mr-${mr.iid}`;
    await writeOutputs(snapshotDir, id, mr, renderMrMarkdown(mr), snapshot.render);
    written.push(id);
  }
  return written;
}

async function processPipelines(
  http: HttpClient,
  snapshot: z.infer<typeof PipelinesSnapshot>,
  snapshotDir: string,
): Promise<readonly string[]> {
  const project = encodeProject(snapshot.projectId);
  const raw = await listAll<Parameters<typeof reshapeGitLabPipeline>[0]>(
    http,
    `/projects/${project}/pipelines`,
    {
      ...(snapshot.ref ? { ref: snapshot.ref } : {}),
      order_by: 'id',
      sort: 'desc',
    },
    snapshot.maxItems,
  );

  const written: string[] = [];
  for (const rawPipeline of raw) {
    const base = reshapeGitLabPipeline(rawPipeline);
    const jobs = snapshot.includeJobs
      ? (await listAll<RawJob>(http, `/projects/${project}/pipelines/${base.id}/jobs`, {}, 1000)).map(normaliseJob)
      : undefined;
    const pipeline: ExtractedPipeline = { ...base, ...(jobs ? { jobs } : {}) };
    const id = `pipeline-${pipeline.id}`;
    await writeOutputs(snapshotDir, id, pipeline, renderPipelineMarkdown(pipeline), snapshot.render);
    written.push(id);
  }
  return written;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = resolve(process.argv[2] ?? './extract.config.gitlab.json');
  log(`config: ${configPath}`);
  const config = await loadJsonConfig(configPath, ExtractConfig);

  const http = createNamedHttpClient(SCRIPT_NAME, loadGitLabAuth());

  const outputRoot = resolve(dirname(configPath), config.outputDir);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let totalItems = 0;

  for (const snapshot of config.snapshots) {
    log(`snapshot "${snapshot.name}" (${snapshot.type}, project ${snapshot.projectId})`);
    const snapshotDir = join(outputRoot, snapshot.name);
    await mkdir(snapshotDir, { recursive: true });

    let written: readonly string[];
    if (snapshot.type === 'issues') written = await processIssues(http, snapshot, snapshotDir);
    else if (snapshot.type === 'mrs') written = await processMrs(http, snapshot, snapshotDir);
    else written = await processPipelines(http, snapshot, snapshotDir);

    await writeManifest(
      snapshotDir,
      buildManifest(SCRIPT_NAME, startedAt, snapshot, {
        type: snapshot.type,
        projectId: snapshot.projectId,
        itemCount: written.length,
        itemIds: written,
      }),
    );
    log(`  wrote ${written.length} item(s) → ${snapshotDir}`);
    totalItems += written.length;
  }

  const durationMs = Date.now() - startMs;
  log(`done — ${totalItems} item(s) across ${config.snapshots.length} snapshot(s) in ${durationMs}ms`);
}

await runIfMain(SCRIPT_NAME, import.meta.url, main);
