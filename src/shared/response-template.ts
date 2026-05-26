/**
 * response-template.ts — runtime markdown+frontmatter renderer.
 *
 * Why this exists:
 *   Tool responses ought to look identical regardless of which LLM (Claude /
 *   GPT / Gemini behind Copilot) eventually reads them. Hand-written response
 *   shapes drift over time and the "single source of truth" for output
 *   structure ends up split between TypeScript types, JSDoc, README tables,
 *   and tribal knowledge.
 *
 * The fix: store the canonical output shape in a single `templates/responses/
 * <name>.md` file with YAML frontmatter (id, vars, description) and a
 * Handlebars-subset body. Tool handlers call `templateResponse(name, vars,
 * meta)` and get a deterministic ToolResponse back. Same inputs → byte
 * identical output across model providers.
 *
 * Template syntax (self-contained, no `handlebars` dep):
 *   {{ var }}                — substitute string-coerced value (markdown only)
 *   {{ var.nested.path }}    — dot-path access
 *   {{ var | default:"—" }}  — fallback when nullish or empty string
 *   {{#if var}}...{{/if}}    — conditional block (truthy = non-empty)
 *   {{#each list}}...{{/each}} — loop; use {{ this.field }} or {{ field }}
 *
 * Caching: templates are read once and cached in-process. Use `clearCache()`
 * in tests / hot-reload scenarios. The cache key is the absolute file path.
 *
 * @see src/shared/response-meta.ts — envelope contract
 * @see templates/responses/ — canonical templates
 */
import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';

import { buildMeta, wrapResponse, type RateLimitInfo, type ToolResponse } from './response-meta.js';

export interface TemplateFrontmatter {
  readonly id: string;
  readonly description?: string;
  readonly vars?: readonly string[];
  readonly version?: string;
}

export interface ParsedTemplate {
  readonly frontmatter: TemplateFrontmatter;
  readonly body: string;
  readonly path: string;
}

const cache = new Map<string, ParsedTemplate>();

let templatesRoot = nodePath.resolve(process.cwd(), 'templates', 'responses');

export function setTemplatesRoot(directory: string): void {
  templatesRoot = directory;
  cache.clear();
}

export function clearCache(): void {
  cache.clear();
}

/** Read + parse a template once; subsequent calls hit the cache. */
export function loadTemplate(name: string): ParsedTemplate {
  const filePath = nodePath.resolve(templatesRoot, `${name}.md`);
  const hit = cache.get(filePath);
  if (hit) return hit;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- templatesRoot is workspace-local, name is a known template slug
  if (!existsSync(filePath)) {
    throw new Error(`response-template: missing templates/responses/${name}.md`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same as above; templates live in tracked repo
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseTemplate(raw, filePath);
  cache.set(filePath, parsed);
  return parsed;
}

/**
 * Tiny YAML frontmatter parser — only handles flat scalars + lists.
 *
 * Splits on lines rather than using a multi-line regex so there's no
 * pathological backtracking surface (sonarjs/slow-regex) and CRLF/LF
 * inputs parse identically.
 */
export function parseTemplate(raw: string, sourcePath: string): ParsedTemplate {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { frontmatter: { id: sourcePath }, body: raw, path: sourcePath };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return { frontmatter: { id: sourcePath }, body: raw, path: sourcePath };
  }
  return {
    frontmatter: parseFrontmatterBlock(lines.slice(1, end)) as unknown as TemplateFrontmatter,
    body: lines.slice(end + 1).join('\n'),
    path: sourcePath,
  };
}

function parseFrontmatterBlock(fmLines: readonly string[]): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  let i = 0;
  while (i < fmLines.length) {
    const parsed = parseFrontmatterKeyValue(fmLines[i]);
    if (!parsed) {
      i++;
      continue;
    }
    const { key, value } = parsed;
    if (value === '' && isListItem(fmLines[i + 1])) {
      const list: string[] = [];
      i++;
      while (i < fmLines.length && isListItem(fmLines[i])) {
        list.push(fmLines[i].replace(/^\s+-\s+/, '').trim());
        i++;
      }
      fm[key] = list;
      continue;
    }
    fm[key] = stripQuotes(value);
    i++;
  }
  return fm;
}

function parseFrontmatterKeyValue(line: string | undefined): { key: string; value: string } | null {
  if (line === undefined) return null;
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return null;
  const key = line.slice(0, colonIndex);
  if (!/^[\w-]+$/.test(key)) return null;
  return { key, value: line.slice(colonIndex + 1).trim() };
}

function isListItem(line: string | undefined): boolean {
  return line !== undefined && /^\s+-\s+/.test(line);
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const last = value.at(-1);
    if (last === value[0]) return value.slice(1, -1);
  }
  return value;
}

/** Render a loaded template with vars. */
export function renderTemplate(name: string, variables: Record<string, unknown>): string {
  const tpl = loadTemplate(name);
  return renderBody(tpl.body, variables);
}

/**
 * Build the canonical response envelope using a template for the data shape.
 *
 * NOTE: returns `data` as the rendered markdown string. Callers that need
 * structured data alongside the rendered view should set `dataOverride` and
 * use the template only for the human-readable mirror.
 */
export function templateResponse<T = string>(
  name: string,
  variables: Record<string, unknown>,
  metaInput: {
    correlationId: string;
    server: string;
    tool: string;
    durationMs?: number;
    truncated?: boolean;
    rateLimit?: RateLimitInfo;
  },
  dataOverride?: T,
): ToolResponse<T | string> {
  const rendered = renderTemplate(name, variables);
  const data = (dataOverride ?? rendered) as T | string;
  return wrapResponse(data, buildMeta(data, metaInput));
}

// ── body renderer ──────────────────────────────────────────────────────────
//
// Order matters: expand block helpers (loops → conditionals) BEFORE substituting
// scalar `{{ var }}` placeholders, otherwise inner `{{ this.field }}` inside an
// {{#each}} gets evaluated against the outer scope (where `this` is absent) and
// resolves to empty before the loop ever runs. Inside a block, we recurse into
// `renderBody` so nested loops/conditionals/vars all resolve under the right
// scope.

function renderBody(body: string, scope: Record<string, unknown>): string {
  let out = renderLoops(body, scope);
  out = renderConditionals(out, scope);
  out = renderInterpolations(out, scope);
  return out;
}

function renderInterpolations(input: string, scope: Record<string, unknown>): string {
  // Regex is bounded — input is a template body (≤ 30 KB Copilot limit); no ReDoS surface.
  const re = /\{\{\s*([\w.]+)(?:\s*\|\s*default:\s*"([^"]*)")?\s*\}\}/g; // eslint-disable-line security/detect-unsafe-regex
  return input.replaceAll(re, (_match: string, path: string, fallback: string | undefined) =>
    stringifyValue(lookup(scope, path), fallback),
  );
}

function stringifyValue(value: unknown, fallback: string | undefined): string {
  if (value === undefined || value === null || value === '') return fallback ?? '';
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  return '';
}

function renderConditionals(input: string, scope: Record<string, unknown>): string {
  return input.replaceAll(
    /\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match: string, path: string, inner: string) => (truthy(lookup(scope, path)) ? renderBody(inner, scope) : ''),
  );
}

/** Walk from `bodyStart` counting nested {{#each}} / {{/each}} tags. Returns
 *  the index AFTER the matching `{{/each}}`, or -1 if unbalanced. */
function findMatchingEnd(input: string, bodyStart: number): number {
  let depth = 1;
  let i = bodyStart;
  while (i < input.length && depth > 0) {
    const nextOpen = input.indexOf('{{#each', i);
    const nextClose = input.indexOf('{{/each}}', i);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 7;
    } else {
      depth--;
      i = nextClose + 9;
    }
  }
  return depth === 0 ? i : -1;
}

function buildItemScope(item: unknown, parent: Record<string, unknown>): Record<string, unknown> {
  if (item !== null && typeof item === 'object') {
    return { ...(item as Record<string, unknown>), this: item, '@root': parent };
  }
  return { this: item, '@root': parent };
}

function renderLoops(input: string, scope: Record<string, unknown>): string {
  let out = input;
  for (;;) {
    const open = /\{\{#each\s+([\w.]+)\}\}/.exec(out);
    if (!open) break;
    const start = open.index;
    const bodyStart = start + open[0].length;
    const path = open[1];
    const end = findMatchingEnd(out, bodyStart);
    if (end === -1) break;
    const inner = out.slice(bodyStart, end - 9);
    const list = lookup(scope, path);
    const replacement =
      Array.isArray(list) && list.length > 0
        ? list.map((item) => renderBody(inner, buildItemScope(item, scope))).join('')
        : '';
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

function lookup(scope: Record<string, unknown>, path: string): unknown {
  if (path === 'this') return scope['this'];
  const parts = path.split('.');
  let current: unknown = scope;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
