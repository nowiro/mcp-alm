#!/usr/bin/env node
/**
 * extract-sonar — deterministyczny pipeline danych SonarQube / SonarCloud.
 *
 * Druga bramka równoległa do MCP. Reusuje `sonar-reshape.ts` i shared
 * `http-client.ts` z konfiguracją `extract.config.sonar.json`.
 *
 * Snapshot ma jeden z 4 typów (wybierz lub łącz w jednym configu):
 *   - `type: "quality_gate"` → status QG dla projektu (key compliance use case)
 *   - `type: "issues"`       → wszystkie issues z filtrami (paginowane)
 *   - `type: "hotspots"`     → wszystkie security hotspots (paginowane)
 *   - `type: "measures"`     → metryki projektu w jednym fetchu
 *
 * Każdy snapshot pisze:
 *   - `<outputDir>/<snapshot>/_summary.json` — pełny snapshot jako jeden plik
 *   - `<outputDir>/<snapshot>/_summary.md`   — human-readable rendering
 *   - `<outputDir>/<snapshot>/_manifest.json`
 *
 * UWAGA: `issues` i `hotspots` mogą być duże — domyślny limit 5000.
 *
 * Run:
 *   node dist/extract-sonar.js [path/to/extract.config.sonar.json]
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { loadSonarAuth } from './shared/auth.js';
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
import { createNamedHttpClient, type HttpClient } from './shared/http-client.js';
import {
  reshapeHotspot,
  reshapeSonarIssue,
  type CanonicalHotspot,
  type CanonicalSonarIssue,
} from './shared/sonar-reshape.js';

const SCRIPT_NAME = 'extract-sonar';

// ── Config ───────────────────────────────────────────────────────────────────

const baseSnapshot = {
  name: snapshotNameSchema,
  projectKey: z.string().min(1),
  render: renderFormatsSchema,
} as const;

const QualityGateSnapshot = z.object({
  ...baseSnapshot,
  type: z.literal('quality_gate'),
  branch: z.string().optional(),
  pullRequest: z.string().optional(),
});
const IssuesSnapshot = z.object({
  ...baseSnapshot,
  type: z.literal('issues'),
  severities: z.array(z.enum(['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'])).optional(),
  types: z.array(z.enum(['CODE_SMELL', 'BUG', 'VULNERABILITY'])).optional(),
  branch: z.string().optional(),
  pullRequest: z.string().optional(),
  maxItems: z.number().int().min(1).max(20_000).default(5000),
});
const HotspotsSnapshot = z.object({
  ...baseSnapshot,
  type: z.literal('hotspots'),
  status: z.enum(['TO_REVIEW', 'REVIEWED']).optional(),
  maxItems: z.number().int().min(1).max(20_000).default(5000),
});
const MeasuresSnapshot = z.object({
  ...baseSnapshot,
  type: z.literal('measures'),
  /** Lista kluczy metryk Sonara — np. ["coverage","duplicated_lines_density","ncloc","bugs"]. */
  metrics: z.array(z.string().min(1)).min(1),
  branch: z.string().optional(),
  pullRequest: z.string().optional(),
});

const SnapshotConfig = z.discriminatedUnion('type', [
  QualityGateSnapshot,
  IssuesSnapshot,
  HotspotsSnapshot,
  MeasuresSnapshot,
]);

export const ExtractConfig = z.object({
  outputDir: z.string().min(1).default('./output/sonar'),
  snapshots: z.array(SnapshotConfig).min(1),
});

// ── Raw shapes ───────────────────────────────────────────────────────────────

interface SonarPaging {
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly total?: number;
}
interface RawIssuesResponse {
  readonly issues?: readonly Parameters<typeof reshapeSonarIssue>[0][];
  readonly paging?: SonarPaging;
}
interface RawHotspotsResponse {
  readonly hotspots?: readonly Parameters<typeof reshapeHotspot>[0][];
  readonly paging?: SonarPaging;
}

interface RawQualityGateCondition {
  readonly status?: string;
  readonly metricKey?: string;
  readonly comparator?: string;
  readonly errorThreshold?: string;
  readonly actualValue?: string;
}
interface RawQualityGateResponse {
  readonly projectStatus?: {
    readonly status?: string;
    readonly conditions?: readonly RawQualityGateCondition[];
    readonly periods?: readonly { readonly index?: number; readonly mode?: string; readonly date?: string }[];
  };
}

interface RawMeasure {
  readonly metric?: string;
  readonly value?: string;
  readonly bestValue?: boolean;
}
interface RawMeasuresResponse {
  readonly component?: {
    readonly key?: string;
    readonly name?: string;
    readonly measures?: readonly RawMeasure[];
  };
}

// ── Output shapes ────────────────────────────────────────────────────────────

export interface QualityGateSummary {
  readonly projectKey: string;
  readonly branch?: string;
  readonly pullRequest?: string;
  readonly status: string;
  readonly conditions: readonly {
    readonly metricKey: string;
    readonly status: string;
    readonly comparator?: string;
    readonly errorThreshold?: string;
    readonly actualValue?: string;
  }[];
}
export interface IssuesSummary {
  readonly projectKey: string;
  readonly filters: {
    readonly severities?: readonly string[];
    readonly types?: readonly string[];
    readonly branch?: string;
    readonly pullRequest?: string;
  };
  readonly total: number;
  readonly truncated: boolean;
  readonly issues: readonly CanonicalSonarIssue[];
}
export interface HotspotsSummary {
  readonly projectKey: string;
  readonly filters: { readonly status?: string };
  readonly total: number;
  readonly truncated: boolean;
  readonly hotspots: readonly CanonicalHotspot[];
}
export interface MeasuresSummary {
  readonly projectKey: string;
  readonly branch?: string;
  readonly pullRequest?: string;
  readonly measures: readonly { readonly metric: string; readonly value?: string; readonly bestValue?: boolean }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = createScriptLogger(SCRIPT_NAME);

async function paginateSonar<TOut>(
  http: HttpClient,
  path: string,
  baseQuery: Record<string, string | number | boolean | undefined>,
  itemsKey: 'issues' | 'hotspots',
  reshape: (raw: unknown) => TOut,
  max: number,
): Promise<{ items: readonly TOut[]; total: number; truncated: boolean }> {
  const out: TOut[] = [];
  let page = 1;
  const PS = 100;
  let lastTotal = 0;
  while (out.length < max) {
    const ps = Math.min(PS, max - out.length);
    const resp = await http.request<RawIssuesResponse | RawHotspotsResponse>({
      path,
      query: { ...baseQuery, ps, p: page },
    });
    lastTotal = resp.paging?.total ?? lastTotal;
    const items = itemsKey === 'issues' ? (resp as RawIssuesResponse).issues : (resp as RawHotspotsResponse).hotspots;
    if (!items || items.length === 0) break;
    for (const it of items) out.push(reshape(it));
    if (items.length < ps) break;
    if (out.length >= lastTotal) break;
    page += 1;
  }
  return { items: out, total: lastTotal, truncated: out.length < lastTotal };
}

// ── Renderers ────────────────────────────────────────────────────────────────

export function renderQualityGateMarkdown(qg: QualityGateSummary): string {
  const lines: string[] = [];
  const target = qg.branch ? ` (branch \`${qg.branch}\`)` : qg.pullRequest ? ` (PR \`${qg.pullRequest}\`)` : '';
  lines.push(`# Quality Gate — ${qg.projectKey}${target}`);
  lines.push('');
  lines.push(`- **Status**: \`${qg.status}\``);
  lines.push('');

  if (qg.conditions.length > 0) {
    lines.push('## Conditions');
    lines.push('');
    lines.push('| Metric | Status | Actual | Threshold | Comparator |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of qg.conditions) {
      lines.push(
        `| \`${c.metricKey}\` | ${c.status} | ${c.actualValue ?? '—'} | ${c.errorThreshold ?? '—'} | ${c.comparator ?? '—'} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderIssuesMarkdown(summary: IssuesSummary): string {
  const lines: string[] = [];
  lines.push(`# Issues — ${summary.projectKey}`);
  lines.push('');
  lines.push(`- **Total upstream**: ${summary.total}`);
  lines.push(`- **Wyciągnięte**: ${summary.issues.length}`);
  if (summary.truncated) lines.push(`- **Truncated**: TAK (zwiększ \`maxItems\` w configu)`);
  const filters: string[] = [];
  if (summary.filters.severities) filters.push(`severities=${summary.filters.severities.join(',')}`);
  if (summary.filters.types) filters.push(`types=${summary.filters.types.join(',')}`);
  if (summary.filters.branch) filters.push(`branch=${summary.filters.branch}`);
  if (summary.filters.pullRequest) filters.push(`pr=${summary.filters.pullRequest}`);
  if (filters.length > 0) lines.push(`- **Filtry**: ${filters.join(' · ')}`);
  lines.push('');

  if (summary.issues.length === 0) return lines.join('\n');

  lines.push('## Issues');
  lines.push('');
  lines.push('| Key | Severity | Type | Status | Rule | Component | Line |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const i of summary.issues) {
    lines.push(
      `| \`${i.key}\` | ${i.severity} | ${i.type} | ${i.status} | \`${i.rule}\` | ${i.component ?? '—'} | ${i.line ?? '—'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderHotspotsMarkdown(summary: HotspotsSummary): string {
  const lines: string[] = [];
  lines.push(`# Security Hotspots — ${summary.projectKey}`);
  lines.push('');
  lines.push(`- **Total upstream**: ${summary.total}`);
  lines.push(`- **Wyciągnięte**: ${summary.hotspots.length}`);
  if (summary.truncated) lines.push(`- **Truncated**: TAK`);
  if (summary.filters.status) lines.push(`- **Status filter**: ${summary.filters.status}`);
  lines.push('');

  if (summary.hotspots.length === 0) return lines.join('\n');

  lines.push('## Hotspots');
  lines.push('');
  lines.push('| Key | Status | Probability | Category | Component | Line |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const h of summary.hotspots) {
    lines.push(
      `| \`${h.key}\` | ${h.status} | ${h.vulnerabilityProbability ?? '—'} | ${h.securityCategory ?? '—'} | ${h.component ?? '—'} | ${h.line ?? '—'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderMeasuresMarkdown(summary: MeasuresSummary): string {
  const lines: string[] = [];
  const target = summary.branch
    ? ` (branch \`${summary.branch}\`)`
    : summary.pullRequest
      ? ` (PR \`${summary.pullRequest}\`)`
      : '';
  lines.push(`# Measures — ${summary.projectKey}${target}`);
  lines.push('');
  lines.push('| Metric | Value | Best? |');
  lines.push('| --- | --- | --- |');
  for (const m of summary.measures) {
    lines.push(`| \`${m.metric}\` | ${m.value ?? '—'} | ${m.bestValue === true ? '✓' : ''} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ── Output writers ───────────────────────────────────────────────────────────

async function writeSummary(
  baseDir: string,
  summary: unknown,
  markdown: string,
  formats: readonly ('json' | 'markdown')[],
): Promise<void> {
  await writePipelineOutputs({ dir: baseDir, basename: '_summary', data: summary, markdown, formats });
}

// ── Per-type processors ──────────────────────────────────────────────────────

async function processQualityGate(
  http: HttpClient,
  snapshot: z.infer<typeof QualityGateSnapshot>,
  snapshotDir: string,
): Promise<{ itemCount: number }> {
  const resp = await http.request<RawQualityGateResponse>({
    path: '/api/qualitygates/project_status',
    query: {
      projectKey: snapshot.projectKey,
      ...(snapshot.branch ? { branch: snapshot.branch } : {}),
      ...(snapshot.pullRequest ? { pullRequest: snapshot.pullRequest } : {}),
    },
  });
  const summary: QualityGateSummary = {
    projectKey: snapshot.projectKey,
    ...(snapshot.branch ? { branch: snapshot.branch } : {}),
    ...(snapshot.pullRequest ? { pullRequest: snapshot.pullRequest } : {}),
    status: resp.projectStatus?.status ?? 'UNKNOWN',
    conditions: (resp.projectStatus?.conditions ?? []).map((c) => ({
      metricKey: c.metricKey ?? '',
      status: c.status ?? 'UNKNOWN',
      ...(c.comparator ? { comparator: c.comparator } : {}),
      ...(c.errorThreshold ? { errorThreshold: c.errorThreshold } : {}),
      ...(c.actualValue ? { actualValue: c.actualValue } : {}),
    })),
  };
  await writeSummary(snapshotDir, summary, renderQualityGateMarkdown(summary), snapshot.render);
  return { itemCount: 1 };
}

async function processIssues(
  http: HttpClient,
  snapshot: z.infer<typeof IssuesSnapshot>,
  snapshotDir: string,
): Promise<{ itemCount: number }> {
  const baseQuery = {
    componentKeys: snapshot.projectKey,
    ...(snapshot.severities && snapshot.severities.length > 0 ? { severities: snapshot.severities.join(',') } : {}),
    ...(snapshot.types && snapshot.types.length > 0 ? { types: snapshot.types.join(',') } : {}),
    ...(snapshot.branch ? { branch: snapshot.branch } : {}),
    ...(snapshot.pullRequest ? { pullRequest: snapshot.pullRequest } : {}),
    s: 'CREATION_DATE',
    asc: 'true',
  };
  const result = await paginateSonar<CanonicalSonarIssue>(
    http,
    '/api/issues/search',
    baseQuery,
    'issues',
    (r) => reshapeSonarIssue(r as Parameters<typeof reshapeSonarIssue>[0]),
    snapshot.maxItems,
  );
  const summary: IssuesSummary = {
    projectKey: snapshot.projectKey,
    filters: {
      ...(snapshot.severities ? { severities: snapshot.severities } : {}),
      ...(snapshot.types ? { types: snapshot.types } : {}),
      ...(snapshot.branch ? { branch: snapshot.branch } : {}),
      ...(snapshot.pullRequest ? { pullRequest: snapshot.pullRequest } : {}),
    },
    total: result.total,
    truncated: result.truncated,
    issues: result.items,
  };
  await writeSummary(snapshotDir, summary, renderIssuesMarkdown(summary), snapshot.render);
  return { itemCount: result.items.length };
}

async function processHotspots(
  http: HttpClient,
  snapshot: z.infer<typeof HotspotsSnapshot>,
  snapshotDir: string,
): Promise<{ itemCount: number }> {
  const baseQuery = {
    projectKey: snapshot.projectKey,
    ...(snapshot.status ? { status: snapshot.status } : {}),
  };
  const result = await paginateSonar<CanonicalHotspot>(
    http,
    '/api/hotspots/search',
    baseQuery,
    'hotspots',
    (r) => reshapeHotspot(r as Parameters<typeof reshapeHotspot>[0]),
    snapshot.maxItems,
  );
  const summary: HotspotsSummary = {
    projectKey: snapshot.projectKey,
    filters: snapshot.status ? { status: snapshot.status } : {},
    total: result.total,
    truncated: result.truncated,
    hotspots: result.items,
  };
  await writeSummary(snapshotDir, summary, renderHotspotsMarkdown(summary), snapshot.render);
  return { itemCount: result.items.length };
}

async function processMeasures(
  http: HttpClient,
  snapshot: z.infer<typeof MeasuresSnapshot>,
  snapshotDir: string,
): Promise<{ itemCount: number }> {
  const resp = await http.request<RawMeasuresResponse>({
    path: '/api/measures/component',
    query: {
      component: snapshot.projectKey,
      metricKeys: snapshot.metrics.join(','),
      ...(snapshot.branch ? { branch: snapshot.branch } : {}),
      ...(snapshot.pullRequest ? { pullRequest: snapshot.pullRequest } : {}),
    },
  });
  const summary: MeasuresSummary = {
    projectKey: snapshot.projectKey,
    ...(snapshot.branch ? { branch: snapshot.branch } : {}),
    ...(snapshot.pullRequest ? { pullRequest: snapshot.pullRequest } : {}),
    measures: (resp.component?.measures ?? []).map((m) => ({
      metric: m.metric ?? '',
      ...(m.value !== undefined ? { value: m.value } : {}),
      ...(m.bestValue !== undefined ? { bestValue: m.bestValue } : {}),
    })),
  };
  await writeSummary(snapshotDir, summary, renderMeasuresMarkdown(summary), snapshot.render);
  return { itemCount: summary.measures.length };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = resolve(process.argv[2] ?? './extract.config.sonar.json');
  log(`config: ${configPath}`);
  const config = await loadJsonConfig(configPath, ExtractConfig);

  const http = createNamedHttpClient(SCRIPT_NAME, loadSonarAuth());

  const outputRoot = resolve(dirname(configPath), config.outputDir);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let totalItems = 0;

  for (const snapshot of config.snapshots) {
    log(`snapshot "${snapshot.name}" (${snapshot.type}, project ${snapshot.projectKey})`);
    const snapshotDir = join(outputRoot, snapshot.name);
    await mkdir(snapshotDir, { recursive: true });

    let result: { itemCount: number };
    if (snapshot.type === 'quality_gate') result = await processQualityGate(http, snapshot, snapshotDir);
    else if (snapshot.type === 'issues') result = await processIssues(http, snapshot, snapshotDir);
    else if (snapshot.type === 'hotspots') result = await processHotspots(http, snapshot, snapshotDir);
    else result = await processMeasures(http, snapshot, snapshotDir);

    await writeManifest(
      snapshotDir,
      buildManifest(SCRIPT_NAME, startedAt, snapshot, {
        type: snapshot.type,
        projectKey: snapshot.projectKey,
        itemCount: result.itemCount,
      }),
    );
    log(`  wrote ${result.itemCount} item(s) → ${snapshotDir}`);
    totalItems += result.itemCount;
  }

  const durationMs = Date.now() - startMs;
  log(`done — ${totalItems} item(s) across ${config.snapshots.length} snapshot(s) in ${durationMs}ms`);
}

await runIfMain(SCRIPT_NAME, import.meta.url, main);
