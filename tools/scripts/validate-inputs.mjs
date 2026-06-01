#!/usr/bin/env node

/**
 * validate-inputs.mjs — sanity-check that every `defineTool({...})` block
 * inside `src/server-*.ts` declares the full contract:
 *
 *   - `name:` string literal, kebab-cased prefix matching server (e.g. `jira.get_issue`)
 *   - `description:` non-empty string literal
 *   - `inputSchema:` references a named Zod schema (not inline)
 *   - `handle` or `async handle` method present
 *
 * Static-only (regex over source). No type-checker round-trip → fast,
 * runnable in pre-commit. tsc catches wiring issues only after full build;
 * this script gates faster.
 *
 * Wired into `npm run verify` — contract drift blocks commits.
 *
 * Usage:
 *   npm run validate:inputs
 *   npm run validate:inputs -- --json
 *
 * Exit codes: 0 clean, 1 any findings.
 *
 * @see .github/instructions/mcp-server.instructions.md — defineTool contract
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ARGS = parseArgs(process.argv.slice(2));
const JSON_OUT = ARGS.json === true;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** @type {Array<{ file: string; tool: string; severity: 'ok'|'warn'|'err'; msg: string }>} */
const findings = [];

function record(file, tool, severity, msg) {
  findings.push({ file, tool, severity, msg });
}

const SRC_DIR = nodePath.resolve(ROOT, 'src');
const serverFiles = listFiles(SRC_DIR).filter((f) => /[/\\]server-[\w-]+\.ts$/.test(f));

if (serverFiles.length === 0) {
  if (!JSON_OUT) process.stdout.write(`${c.warn('⚠')} no server files found at src/server-*.ts\n`);
  process.exit(0);
}

if (!JSON_OUT) process.stdout.write(`${c.bold('▶ Validating')} ${serverFiles.length} server file(s)\n`);

let totalTools = 0;
for (const file of serverFiles) {
  const rel = relPath(file);
  const src = readFileSync(file, 'utf8');
  const serverName = nodePath.basename(file, '.ts').replace(/^server-/, '');
  const toolsInFile = extractDefineToolBlocks(src);
  totalTools += toolsInFile.length;
  if (toolsInFile.length === 0) {
    record(rel, '', 'warn', 'no defineTool({...}) blocks found');
    continue;
  }
  for (const block of toolsInFile) {
    validateBlock(rel, serverName, block);
  }
}

// Count-guard: documented tool count must equal the registry count, so a tool
// add/remove can't leave a stale "N/N tools clean" / "~N narzędzi" in the docs.
checkDocumentedCount(totalTools);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ findings, totalTools }, null, 2) + '\n');
} else {
  const errors = findings.filter((f) => f.severity === 'err');
  const warns = findings.filter((f) => f.severity === 'warn');
  for (const f of findings) {
    const icon = f.severity === 'ok' ? c.ok('✓') : f.severity === 'warn' ? c.warn('⚠') : c.err('✗');
    const tag = f.tool ? c.dim(`[${f.tool}] `) : '';
    process.stdout.write(`  ${icon} ${c.dim(f.file)}  ${tag}${f.msg}\n`);
  }
  process.stdout.write(`\n${c.bold('Summary:')} ${c.ok(`${totalTools - errors.length}/${totalTools} tools clean`)}`);
  if (warns.length > 0) process.stdout.write(`  ${c.warn(`${warns.length} warn`)}`);
  if (errors.length > 0) process.stdout.write(`  ${c.err(`${errors.length} err`)}`);
  process.stdout.write('\n');
}

process.exit(findings.some((f) => f.severity === 'err') ? 1 : 0);

// ── checks ─────────────────────────────────────────────────────────────────

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

function validateBlock(file, serverName, block) {
  const nameMatch = /\bname\s*:\s*['"`]([\w.-]+)['"`]/.exec(block);
  const tool = nameMatch ? nameMatch[1] : '?';

  if (!nameMatch) {
    record(file, tool, 'err', 'name: missing or not a string literal');
    return;
  }
  if (!tool.startsWith(`${serverName}.`)) {
    record(file, tool, 'err', `name must start with "${serverName}." (matched server filename) — got "${tool}"`);
  }
  if (!/\bdescription\s*:\s*['"`][^'"`]+['"`]/.test(block)) {
    record(file, tool, 'err', 'description: missing or empty literal');
  }
  if (!/\binputSchema\s*:\s*\w/.test(block)) {
    record(file, tool, 'err', 'inputSchema: missing — must reference a named Zod schema');
  }
  if (!/\b(?:async\s+)?handle\s*[(:]/.test(block)) {
    record(file, tool, 'err', 'handle method missing');
  }

  if (
    nameMatch &&
    tool.startsWith(`${serverName}.`) &&
    /\bdescription\s*:\s*['"`][^'"`]+['"`]/.test(block) &&
    /\binputSchema\s*:\s*\w/.test(block) &&
    /\b(?:async\s+)?handle\s*[(:]/.test(block)
  ) {
    record(file, tool, 'ok', 'contract OK');
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Assert every documented tool count equals the registry count. Scans the
 * `validate:inputs` example marker in README (`N/N tools clean`) and the
 * CHANGELOG roster (`~N narzędzi`). A finding (err) fails `verify`.
 */
function checkDocumentedCount(expected) {
  const docs = [
    { file: 'README.md', re: /(\d+)\/\d+\s+tools\s+clean/g },
    { file: 'CHANGELOG.md', re: /~\s*(\d+)\s+narzędz/g },
  ];
  for (const { file, re } of docs) {
    let txt;
    try {
      txt = readFileSync(nodePath.resolve(ROOT, file), 'utf8');
    } catch {
      continue; // doc missing — nothing to guard
    }
    for (const m of txt.matchAll(re)) {
      const n = Number(m[1]);
      if (n !== expected) {
        record(file, '', 'err', `documented tool count ${n} ≠ registry ${expected} — sync the doc or the registry`);
      }
    }
  }
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
