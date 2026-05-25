/**
 * Reshape a raw Confluence page response into a token-friendly canonical form.
 *
 * Why this exists:
 *   - The v2 `pages/{id}` endpoint returns body in one of: `storage` (raw
 *     wiki-storage XML/HTML), `view` (rendered HTML), `atlas_doc_format` (ADF
 *     JSON), or `anonymous_export_view`. HTML breaks the LLM context window
 *     surprisingly quickly — a single 30-page handbook can spend 50k tokens
 *     on `<div class="wiki-content">` wrappers alone.
 *   - We request `atlas_doc_format` (ADF) and pipe it through `adfToMarkdown`
 *     so the LLM gets compact Markdown instead.
 *   - We also strip the verbose `_links` / `version.message` / `body.storage`
 *     metadata that the API returns by default.
 *
 * Large-body protection: if the rendered Markdown exceeds `maxChars` (default
 * 8 000 chars ≈ 2 800 tokens after the 2026-06 billing change), we truncate
 * and emit a `truncated: true` flag with the cut byte offset so the caller
 * can resume via a deep-link API.
 *
 * Summary mode (`mode: 'summary'`): instead of the full body we return an intro
 * (`SUMMARY_INTRO_CHARS` characters) plus the headings (H1–H6) as a table of
 * contents. Cuts a 30 KB handbook page to ~1 KB while still giving the agent
 * enough to decide whether a follow-up `mode: 'full'` call is worth the budget.
 *
 * Key order in the returned object is fixed (id → title → metadata → body) so
 * that Copilot's prefix cache stays warm across calls.
 */
import { adfToMarkdown, type AdfNode } from './adf.js';

/** Output mode toggle exposed on `confluence.get_page`. */
export type PageMode = 'full' | 'summary';

export interface CanonicalPage {
  readonly id: string;
  readonly title: string;
  readonly spaceId?: string;
  readonly status?: string;
  readonly version?: number;
  readonly createdAt?: string;
  readonly authorId?: string;
  readonly url?: string;
  readonly mode: PageMode;
  readonly bodyMd?: string;
  readonly headings?: readonly string[];
  readonly truncated?: boolean;
  readonly truncatedAtChars?: number;
}

interface RawPageBody {
  readonly value?: unknown;
  readonly representation?: string;
}

interface RawPage {
  readonly id: string;
  readonly title: string;
  readonly spaceId?: string;
  readonly status?: string;
  readonly authorId?: string;
  readonly createdAt?: string;
  readonly version?: { readonly number?: number };
  readonly body?: {
    readonly atlas_doc_format?: RawPageBody;
    readonly storage?: RawPageBody;
    readonly view?: RawPageBody;
  };
  readonly _links?: { readonly webui?: string; readonly base?: string };
}

/** Lowered from the historical 24 000 — see PLAN.md AC4. */
const DEFAULT_MAX_CHARS = 8000;
/** First N chars kept as the intro paragraph in summary mode. */
const SUMMARY_INTRO_CHARS = 500;
/**
 * Pattern that matches ATX-style markdown headings (`#` … `######`).
 * Anchored both sides + non-greedy capture; no backtracking blow-up because the
 * leading `#` repetition has a tight `{1,6}` cap and the body is bounded by
 * a non-greedy `(.+?)` against `\s*$` — linear with respect to line length.
 */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;

export interface ReshapeOptions {
  readonly maxChars?: number;
  readonly mode?: PageMode;
}

export function reshapeConfluencePage(raw: RawPage, opts: ReshapeOptions = {}): CanonicalPage {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const mode: PageMode = opts.mode ?? 'full';

  const rendered = renderBodyMd(raw);
  const body = mode === 'summary' ? buildSummary(rendered) : truncateBody(rendered, maxChars);

  // Explicit, stable key order — see file-level note about Copilot prefix caching.
  return {
    id: raw.id,
    title: raw.title,
    ...(raw.spaceId ? { spaceId: raw.spaceId } : {}),
    ...(raw.status ? { status: raw.status } : {}),
    ...(typeof raw.version?.number === 'number' ? { version: raw.version.number } : {}),
    ...(raw.createdAt ? { createdAt: raw.createdAt } : {}),
    ...(raw.authorId ? { authorId: raw.authorId } : {}),
    ...(pickUrl(raw) ? { url: pickUrl(raw) } : {}),
    mode,
    ...(body.bodyMd ? { bodyMd: body.bodyMd } : {}),
    ...(body.headings && body.headings.length > 0 ? { headings: body.headings } : {}),
    ...(body.truncated ? { truncated: true, truncatedAtChars: body.truncatedAtChars } : {}),
  };
}

interface BodyShape {
  readonly bodyMd?: string;
  readonly headings?: readonly string[];
  readonly truncated?: boolean;
  readonly truncatedAtChars?: number;
}

function truncateBody(full: string, maxChars: number): BodyShape {
  if (full.length === 0) return {};
  if (full.length > maxChars) {
    return {
      bodyMd: full.slice(0, maxChars) + '\n…[truncated]',
      truncated: true,
      truncatedAtChars: maxChars,
    };
  }
  return { bodyMd: full };
}

function buildSummary(full: string): BodyShape {
  if (full.length === 0) return {};
  const headings = extractHeadings(full);
  const intro = full.slice(0, SUMMARY_INTRO_CHARS);
  const truncated = full.length > SUMMARY_INTRO_CHARS;
  return {
    bodyMd: truncated ? intro + '\n…[truncated]' : intro,
    headings,
    ...(truncated ? { truncated: true, truncatedAtChars: SUMMARY_INTRO_CHARS } : {}),
  };
}

function extractHeadings(md: string): readonly string[] {
  const headings: string[] = [];
  for (const match of md.matchAll(HEADING_RE)) {
    const [, hashes, body] = match;
    const text = body.trim();
    if (text) headings.push(`${'#'.repeat(hashes.length)} ${text}`);
  }
  return headings;
}

function renderBodyMd(raw: RawPage): string {
  const body = pickBody(raw);
  if (!body) return '';
  if (body.representation === 'atlas_doc_format') {
    const parsed = parseAdfValue(body.value);
    return parsed ? adfToMarkdown(parsed) : '';
  }
  // storage / view come back as HTML / XML. We cannot render those losslessly
  // without a parser; surface the raw text and let the caller decide (the
  // canonical fix is to switch the upstream call to `atlas_doc_format`).
  return typeof body.value === 'string' ? body.value : '';
}

function pickBody(raw: RawPage): { value: unknown; representation: string } | undefined {
  const adf = raw.body?.atlas_doc_format;
  if (adf?.value !== undefined) return { value: adf.value, representation: 'atlas_doc_format' };
  const storage = raw.body?.storage;
  if (storage?.value !== undefined) return { value: storage.value, representation: 'storage' };
  const view = raw.body?.view;
  if (view?.value !== undefined) return { value: view.value, representation: 'view' };
  return undefined;
}

function parseAdfValue(value: unknown): AdfNode | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return value as AdfNode;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as AdfNode;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function pickUrl(raw: RawPage): string | undefined {
  const base = raw._links?.base ?? '';
  const webui = raw._links?.webui ?? '';
  if (!webui) return undefined;
  return base ? `${base}${webui}` : webui;
}
