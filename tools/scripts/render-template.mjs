#!/usr/bin/env node

/**
 * render-template.mjs — preview a response template with sample vars.
 *
 * Devloop helper: edit a template under `templates/responses/`, point this
 * script at a JSON fixture, see the rendered output before plugging the
 * template into a real tool handler.
 *
 * Re-implements the renderer from `src/shared/response-template.ts` so the
 * script stays self-contained (.mjs, no TS / build step). Behaviour MUST
 * track that file; a vitest spec in `src/shared/response-template.spec.ts`
 * pins the contract.
 *
 * Usage:
 *   npm run template:list
 *   npm run template:render -- --name=jira-issue --vars=tests/fixtures/jira-issue.json
 *   npm run template:render -- --name=error --vars=- < error.json
 *
 * Flags:
 *   --name=<slug>     template basename (no .md)
 *   --vars=<path|->   JSON file with the variables (or `-` for stdin)
 *   --list            list available templates
 *   --root=<dir>      override templates root (default: templates/responses)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ARGS = parseArgs(process.argv.slice(2));
const root = nodePath.resolve(ROOT, ARGS.root ?? 'templates/responses');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

if (ARGS.list === true) {
  if (!existsSync(root)) {
    process.stdout.write(`${c.err('No templates root:')} ${root}\n`);
    process.exit(1);
  }
  process.stdout.write(`${c.bold('Available templates:')}\n`);
  for (const f of readdirSync(root).filter((n) => n.endsWith('.md'))) {
    const parsed = parseTemplate(readFileSync(nodePath.resolve(root, f), 'utf8'));
    process.stdout.write(`  ${c.ok(f.replace(/\.md$/, ''))}  ${c.dim('— ' + (parsed.frontmatter.description ?? ''))}\n`);
  }
  process.exit(0);
}

if (!ARGS.name || !ARGS.vars) {
  process.stdout.write(`${c.err('Both --name and --vars are required')}\n`);
  process.stdout.write(`${c.dim('Usage: npm run template:render -- --name=<slug> --vars=<path|->')}\n`);
  process.exit(1);
}

const tplPath = nodePath.resolve(root, `${ARGS.name}.md`);
if (!existsSync(tplPath)) {
  process.stdout.write(`${c.err('Missing:')} ${tplPath}\n`);
  process.exit(1);
}
const parsed = parseTemplate(readFileSync(tplPath, 'utf8'));
process.stdout.write(`${c.dim(`▶ ${ARGS.name} (id=${parsed.frontmatter.id ?? '?'}, version=${parsed.frontmatter.version ?? '?'})`)}\n`);

const varsRaw = ARGS.vars === '-' ? readFileSync(0, 'utf8') : readFileSync(nodePath.resolve(ROOT, ARGS.vars), 'utf8');
let vars;
try {
  vars = JSON.parse(varsRaw);
} catch (e) {
  process.stdout.write(`${c.err('Invalid JSON:')} ${e.message}\n`);
  process.exit(1);
}

const out = renderBody(parsed.body, vars);
process.stdout.write(`\n${c.bold('─── BEGIN RENDERED ───')}\n`);
process.stdout.write(out);
process.stdout.write(`${c.bold('\n─── END RENDERED ───')}\n`);

// ── helpers (mirror src/shared/response-template.ts) ────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const kv = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (!kv) continue;
    out[kv[1]] = kv[2] ?? true;
  }
  return out;
}

function parseTemplate(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') return { frontmatter: {}, body: raw };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { frontmatter: {}, body: raw };
  const fm = {};
  const fmLines = lines.slice(1, end);
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIdx);
    if (!/^[\w-]+$/.test(key)) {
      i++;
      continue;
    }
    const value = line.slice(colonIdx + 1).trim();
    if (value === '' && i + 1 < fmLines.length && /^\s+-\s+/.test(fmLines[i + 1])) {
      const list = [];
      i++;
      while (i < fmLines.length && /^\s+-\s+/.test(fmLines[i])) {
        list.push(fmLines[i].replace(/^\s+-\s+/, '').trim());
        i++;
      }
      fm[key] = list;
      continue;
    }
    fm[key] = stripQuotes(value);
    i++;
  }
  return { frontmatter: fm, body: lines.slice(end + 1).join('\n') };
}

function stripQuotes(value) {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const last = value.at(-1);
    if (last === value[0]) return value.slice(1, -1);
  }
  return value;
}

function renderBody(body, scope) {
  let out = renderLoops(body, scope);
  out = renderConditionals(out, scope);
  out = renderInterpolations(out, scope);
  return out;
}

function renderInterpolations(input, scope) {
  return input.replaceAll(/\{\{\s*([\w.]+)(?:\s*\|\s*default:\s*"([^"]*)")?\s*\}\}/g, (_, path, fallback) => {
    const v = lookup(scope, path);
    if (v === undefined || v === null || v === '') return fallback ?? '';
    if (Array.isArray(v)) return String(v.length);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

function renderConditionals(input, scope) {
  return input.replaceAll(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, path, inner) =>
    truthy(lookup(scope, path)) ? renderBody(inner, scope) : '',
  );
}

function renderLoops(input, scope) {
  let out = input;
  for (;;) {
    const open = /\{\{#each\s+([\w.]+)\}\}/.exec(out);
    if (!open) break;
    const start = open.index;
    const bodyStart = start + open[0].length;
    const path = open[1];
    let depth = 1;
    let i = bodyStart;
    while (i < out.length && depth > 0) {
      const nextOpen = out.indexOf('{{#each', i);
      const nextClose = out.indexOf('{{/each}}', i);
      if (nextClose === -1) {
        depth = -1;
        break;
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 7;
      } else {
        depth--;
        i = nextClose + 9;
      }
    }
    if (depth !== 0) break;
    const inner = out.slice(bodyStart, i - 9);
    const list = lookup(scope, path);
    const replacement =
      Array.isArray(list) && list.length > 0
        ? list
            .map((item) => {
              const itemScope = item !== null && typeof item === 'object' ? { ...item, this: item, '@root': scope } : { this: item, '@root': scope };
              return renderBody(inner, itemScope);
            })
            .join('')
        : '';
    out = out.slice(0, start) + replacement + out.slice(i);
  }
  return out;
}

function lookup(scope, path) {
  if (path === 'this') return scope['this'];
  const parts = path.split('.');
  let current = scope;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function truthy(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
