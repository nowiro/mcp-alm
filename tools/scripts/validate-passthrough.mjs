#!/usr/bin/env node

/**
 * validate-passthrough.mjs — guard against unbounded raw-text passthroughs.
 *
 * The token-budget audit (token-budget.mjs) can only see tools that already
 * declare a Zod limit (.max/.default). A tool that returns a raw upstream text
 * blob with NO cap param is invisible to it — and those are exactly the ones
 * that overflow the context (a lockfile, a minified bundle, a CI trace).
 *
 * This script closes that blind spot. Any handler that RETURNS an upstream read
 * directly (`return http.request(...)`) must be reshaped/capped or consciously
 * annotated:
 *   - raw TEXT (`responseMode: 'text'` / `http.request<string>`) → cap helper
 *     (`headBytes` / `tailBytes` / `truncate`),
 *   - raw JSON read (list / entity) → project the canonical fields,
 *   - bounded single-entity read → annotate `// passthrough-ok: <reason>`.
 * Write tools (POST/PUT/DELETE) echoing the created entity are exempt.
 *
 * Tree-shaped passthroughs (Figma node trees) are guarded by unit tests on
 * `pruneNodeTree`, not statically here — there is no low-false-positive static
 * signal for "unbounded JSON tree".
 *
 * Modes:
 *   npm run validate:passthrough              # gate — exit 1 on findings (in `verify`)
 *   npm run validate:passthrough -- --report  # write docs/runs/<date>-passthrough-audit.md
 *   npm run validate:passthrough -- --json    # machine-readable findings + inventory
 *
 * Exit codes: 0 clean (or --report), 1 any findings.
 *
 * @see .github/instructions/llm-optimization.instructions.md (rule 11)
 * @see tools/scripts/token-budget.mjs — the numeric-limit counterpart
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ARGS = parseArgs(process.argv.slice(2));
const JSON_OUT = ARGS.json === true;
const REPORT = ARGS.report === true;
const TODAY = new Date().toISOString().slice(0, 10);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const SRC_DIR = nodePath.resolve(ROOT, 'src');
const serverFiles = listFiles(SRC_DIR).filter((f) => /[/\\]server-[\w-]+\.ts$/.test(f));

/** @type {Array<{ file: string; tool: string; msg: string }>} */
const findings = [];
/** @type {Array<{ file: string; tool: string; kind: 'write' | 'text' | 'json' }>} */
const inventory = [];

for (const file of serverFiles) {
  const rel = relPath(file);
  const src = readFileSync(file, 'utf8');
  for (const block of extractDefineToolBlocks(src)) {
    classifyBlock(rel, block);
  }
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ findings, inventory }, null, 2) + '\n');
  process.exit(findings.length > 0 ? 1 : 0);
}

if (REPORT) {
  writeReport();
  process.exit(0);
}

// ── gate mode ───────────────────────────────────────────────────────────────
process.stdout.write(
  `${c.bold('▶ Passthrough gate')} — ${serverFiles.length} server file(s), ${inventory.length} passthrough site(s)\n`,
);
for (const f of findings) {
  process.stdout.write(`  ${c.err('✗')} ${c.dim(f.file)}  ${c.dim(`[${f.tool}] `)}${f.msg}\n`);
}
if (findings.length === 0) {
  process.stdout.write(`\n${c.bold('Summary:')} ${c.ok('every read passthrough is reshaped, capped, or annotated')}\n`);
} else {
  process.stdout.write(`\n${c.bold('Summary:')} ${c.err(`${findings.length} un-annotated read passthrough(s)`)}\n`);
}
process.exit(findings.length > 0 ? 1 : 0);

// ── classification ──────────────────────────────────────────────────────────

function classifyBlock(file, block) {
  const nameMatch = /\bname\s*:\s*['"`]([\w.-]+)['"`]/.exec(block);
  const tool = nameMatch ? nameMatch[1] : '?';

  // Only direct passthroughs matter: `return http.request(...)`. Tools that
  // assign the response and reshape / cap it before returning are out of scope.
  if (!/return\s+(?:await\s+)?http\.request/.test(block)) return;

  const isText = /responseMode\s*:\s*['"]text['"]/.test(block) || /http\.request\s*<\s*string\s*>/.test(block);
  const isWrite = /\bmethod\s*:\s*['"](?:POST|PUT|DELETE|PATCH)['"]/.test(block);
  const kind = isWrite ? 'write' : isText ? 'text' : 'json';
  const annotated = /\/\/\s*passthrough-ok/.test(block);
  const hasCap = /\b(?:headBytes|tailBytes|truncate)\s*\(/.test(block);
  inventory.push({ file, tool, kind, annotated });

  // Write confirmations legitimately echo the created entity; an explicit
  // `// passthrough-ok` is a conscious opt-out. Either clears the gate.
  if (kind === 'write' || annotated) return;
  // Raw text is fine once routed through a byte/token cap helper.
  if (kind === 'text' && hasCap) return;

  findings.push({
    file,
    tool,
    msg:
      kind === 'text'
        ? 'returns a raw text blob with no cap — route through headBytes()/tailBytes()/truncate(), or annotate `// passthrough-ok: <reason>`'
        : 'returns a raw upstream read with no reshape — project the canonical fields, or annotate `// passthrough-ok: <reason>` if bounded',
  });
}

// ── report writer ───────────────────────────────────────────────────────────

function writeReport() {
  const reportPath = `docs/runs/${TODAY}-passthrough-audit.md`;
  const reportAbs = nodePath.resolve(ROOT, reportPath);

  const byKind = { text: [], json: [], write: [] };
  for (const i of inventory) byKind[i.kind].push(i);

  const statusOf = (r) => (r.annotated ? 'passthrough-ok' : r.kind === 'write' ? 'write confirm' : 'RAW — gate fails');
  const section = (title, rows) =>
    rows.length === 0
      ? `### ${title}\n\n_none_\n`
      : `### ${title} (${rows.length})\n\n| tool | file | status |\n| ---- | ---- | ------ |\n${rows
          .map((r) => `| \`${r.tool}\` | ${r.file} | ${statusOf(r)} |`)
          .join('\n')}\n`;

  const report = `---
id: run.passthrough-audit.${TODAY}
title: Passthrough audit — ${TODAY}
type: run
status: draft
date: ${TODAY}
---

# Passthrough audit — ${TODAY}

Generated by \`npm run validate:passthrough -- --report\` (deterministic; no LLM calls).

Every tool that returns \`http.request(...)\` directly (no reshape / cap layer).
The **gate** (\`npm run validate:passthrough\`, wired into \`verify\`) requires each
**read** passthrough to be capped (text), reshaped (json), or annotated
\`// passthrough-ok\`. Write tools are exempt (they echo the created entity).

Gate findings: ${findings.length === 0 ? 'none — clean ✅' : `${findings.length} ⚠`}

## Inventory

${section('Raw text (cap or annotate)', byKind.text)}
${section('Raw JSON read (reshape or annotate)', byKind.json)}
${section('Write confirmations (exempt)', byKind.write)}

## Decision

Reviewer: any row marked \`RAW — gate fails\` must be reshaped (project canonical
fields) or annotated \`// passthrough-ok: <reason>\` if the payload is bounded.
Delegate code changes to \`connector-author\`; do not mix with this audit PR.
`;

  if (existsSync(reportAbs)) {
    process.stdout.write(`${c.warn('⚠')} ${reportPath} exists (skip)\n`);
    return;
  }
  mkdirSync(nodePath.dirname(reportAbs), { recursive: true });
  writeFileSync(reportAbs, report, 'utf8');
  process.stdout.write(`${c.ok('✓')} wrote ${reportPath}\n`);
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Extract balanced `defineTool({...})` blocks via brace counter. */
function extractDefineToolBlocks(src) {
  const out = [];
  const re = /defineTool\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length - 1; // position of `{`
    let depth = 1;
    let i = start + 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) out.push(src.slice(start, i));
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const kv = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (!kv) continue;
    out[kv[1]] = kv[2] ?? true;
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = nodePath.resolve(dir, name);
      if (statSync(p).isDirectory()) out.push(...listFiles(p));
      else out.push(p);
    }
  } catch {
    /* missing — fine */
  }
  return out;
}

function relPath(abs) {
  return abs.replace(ROOT + nodePath.sep, '').replaceAll('\\', '/');
}
