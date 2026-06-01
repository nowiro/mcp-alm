#!/usr/bin/env node

/**
 * workflow-new-connector.mjs — deterministic scaffolder dla `/new-connector` prompt.
 *
 * Tworzy szkielet nowego ALM connectora od zera:
 *   - `src/server-<name>.ts` z minimalnym `defineTool(health)` + `defineTool(usage)`
 *   - `docs/specs/<name>/spec.md` (analyst stub)
 *   - `docs/specs/<name>/plan.md` (architect stub)
 *   - `docs/plans/<date>-new-connector-<name>.md` (orchestrator plan)
 *   - reminders dla package.json (bin + start script), README, commitlint scope
 *
 * Pełna implementacja (auth, http client, reshape, real tools) zostaje
 * dla LLM agentów (analyst → architect → connector-author).
 *
 * Usage:
 *   npm run workflow:new-connector -- \
 *     --name=asana \
 *     --base-url=https://app.asana.com/api/1.0 \
 *     --auth=pat
 *
 * @see .github/prompts/new-connector.prompt.md
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ARGS = parseArgs(process.argv.slice(2));
const TODAY = new Date().toISOString().slice(0, 10);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const RESERVED = ['jira', 'confluence', 'figma', 'sonar', 'gitlab', 'shared'];
const AUTH_ALLOWED = ['pat', 'basic', 'oauth2'];
const USAGE = 'Usage: npm run workflow:new-connector -- --name=<slug> --base-url=<https://...> --auth=pat|basic|oauth2';

for (const key of ['name', 'base-url', 'auth']) {
  if (!ARGS[key]) {
    process.stdout.write(`${c.err('Missing required arg:')} --${key}\n${c.dim(USAGE)}\n`);
    process.exit(1);
  }
}
const name = ARGS.name;
const baseUrl = ARGS['base-url'];
const auth = ARGS.auth;

if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  process.stdout.write(`${c.err(`name must be kebab-case (got "${name}")`)}\n`);
  process.exit(1);
}
if (RESERVED.includes(name)) {
  process.stdout.write(`${c.err(`"${name}" is reserved (existing connector)`)}\n`);
  process.exit(1);
}
if (!AUTH_ALLOWED.includes(auth)) {
  process.stdout.write(`${c.err(`auth must be one of ${AUTH_ALLOWED.join(', ')}`)}\n`);
  process.exit(1);
}
if (!baseUrl.startsWith('https://')) {
  process.stdout.write(`${c.err('base-url must be HTTPS')}\n`);
  process.exit(1);
}

const serverPath = nodePath.resolve(ROOT, 'src', `server-${name}.ts`);
if (existsSync(serverPath)) {
  process.stdout.write(`${c.err(`src/server-${name}.ts already exists`)}\n`);
  process.exit(1);
}

process.stdout.write(`${c.bold('▶ Pre-flight')}\n  ${c.ok('✓')} name=${name} auth=${auth} baseUrl=${baseUrl}\n`);

const dirs = [`docs/specs/${name}`, `docs/plans`, `docs/runs`];
for (const dir of dirs) {
  const abs = nodePath.resolve(ROOT, dir);
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
    process.stdout.write(`  ${c.ok('✓')} created ${dir}\n`);
  }
}

const planPath = `docs/plans/${TODAY}-new-connector-${name}.md`;
const specPath = `docs/specs/${name}/spec.md`;
const designPath = `docs/specs/${name}/plan.md`;

writeIfMissing(
  planPath,
  `---
id: plan.new-connector.${name}
title: New connector — ${name}
type: plan
status: draft
date: ${TODAY}
agents: [analyst, architect, connector-author, test-engineer, doc-writer]
---

# Plan: nowy connector \`${name}\`

| id   | title                              | agent              | done_when                                |
| ---- | ---------------------------------- | ------------------ | ---------------------------------------- |
| T001 | Spec — outcome + AC                | analyst            | spec.md istnieje, brak \`[?]\`           |
| T002 | Plan — module taxonomy, auth, ADR  | architect          | plan.md istnieje, status: accepted       |
| T003 | Implement client + types + tools   | connector-author   | src/${name}/ + src/server-${name}.ts     |
| T004 | Tests (msw + integration)          | test-engineer      | coverage ≥ 80% na touched files          |
| T005 | Docs (README + CHANGELOG)          | doc-writer         | docs/projects/${name}/ + README row      |
| T006 | Register bin + start script        | architect          | package.json updated                     |
`,
);

writeIfMissing(
  specPath,
  `---
id: spec.${name}
title: ${name} connector
type: spec
status: draft
owner: analyst
---

# Spec: ${name} connector

## Kontekst

[?] Jaki problem / potrzebę to odblokowuje i dlaczego teraz?

## User story

[?] Jako <persona> chcę <zdolność>, aby <wynik>.

## Acceptance criteria

[?] Given / When / Then.

## Success metrics

[?] tokens per call (P50/P95), latency, test coverage ≥ 80%.

## Non-goals

[?] Co explicite nie shipujemy w tej rundzie.

## Open questions

- Auth scheme: ${auth.toUpperCase()} — confirm scopes
- Rate-limit policy: [?]
- Plugin support (custom fields, webhooks): [?]
`,
);

writeIfMissing(
  designPath,
  `---
id: plan.${name}.design
title: Design plan — ${name}
type: plan
status: draft
owner: architect
---

# Design plan: ${name} connector

## Tech additions

[?] Likely none — mamy już fetch, zod, MCP SDK, msw.

## Module taxonomy

- \`src/server-${name}.ts\` — server + tools (inline defineTool)
- \`src/${name}/{client,types,tools}.ts\` (gdy rośnie)
- \`src/shared/${name}-reshape.ts\` — canonical projection (jeśli potrzebne)

## Public surface

| tool | type | description |
| ---- | ---- | ----------- |
| \`${name}.health\` | read | upstream reachable check |
| \`${name}.get_usage_history\` | read | session-tracker dump |
| \`${name}.search\` | read | [?] |
| \`${name}.get\` | read | [?] |

## Canonical entity

\`\`\`ts
export interface Canonical${pascal(name)} {
  id: string;
  // [?] key fields in stable order
}
\`\`\`

## Auth

${auth.toUpperCase()} — token z env (\`${name.toUpperCase()}_TOKEN\`) + fallback do \`~/.config/mcp-alm/config.json\` sekcja \`${name}\`.

## Rate-limit

[?] Policy + headers parsed.

## Risks + mitigations

- [?] Risk: … → Mitigation: …
`,
);

const stubPath = `src/server-${name}.ts`;
writeIfMissing(
  stubPath,
  `#!/usr/bin/env node
/**
 * mcp-${name} — connector for ${name}.
 *
 * Baseline tools shipped from scaffold: health, get_usage_history.
 * Domain tools (search, get, mutate) are added separately via
 * \`npm run workflow:add-tool -- --connector=${name} ...\`.
 */
import { z } from 'zod';

// TODO: import auth loader, http client, mcp server helpers
// import { load${pascal(name)}Auth } from './shared/auth.js';
// import { createHttpClient } from './shared/http-client.js';
// import { defineTool, startMcpServer } from './shared/mcp-server.js';

const SERVER_NAME = 'mcp-${name}';

const HealthInput = z.object({});
const GetUsageHistoryInput = z.object({});

// TODO: uncomment after auth/http-client/mcp-server are wired
// defineTool({
//   name: '${name}.health',
//   description: 'Check upstream reachability.',
//   inputSchema: HealthInput,
//   async handle(_input, ctx) {
//     const started = Date.now();
//     // TODO: HEAD ${baseUrl} via http-client
//     return {
//       data: { ok: true, baseUrl: ${JSON.stringify(baseUrl)} },
//       _meta: { tokensEstimate: 0, correlationId: ctx.correlationId, server: SERVER_NAME, tool: '${name}.health', durationMs: Date.now() - started },
//     };
//   },
// });

// defineTool({
//   name: '${name}.get_usage_history',
//   description: 'Return per-session tool-call ledger.',
//   inputSchema: GetUsageHistoryInput,
//   async handle(_input, ctx) {
//     return {
//       data: sessionTracker.getSummary(),
//       _meta: { tokensEstimate: 0, correlationId: ctx.correlationId, server: SERVER_NAME, tool: '${name}.get_usage_history', durationMs: 0 },
//     };
//   },
// });

// await startMcpServer({ name: SERVER_NAME });
`,
);

process.stdout.write(`\n${c.bold('Reminders — manual edits Copilot must perform:')}\n`);
const reminders = [
  `add bin entry to ${c.bold('package.json')}: ${c.dim(`"mcp-${name}": "./dist/server-${name}.js"`)}`,
  `add start script: ${c.dim(`"start:${name}": "node dist/server-${name}.js"`)}`,
  `add commitlint scope ${c.dim(`"${name}"`)} to ${c.bold('commitlint.config.mjs')}`,
  `add row to ${c.bold('README.md')} "Servers" table`,
  `wire auth in ${c.bold('src/shared/auth.ts')} (env ${name.toUpperCase()}_TOKEN + user-config fallback)`,
];
reminders.forEach((r, i) => process.stdout.write(`  ${i + 1}. ${r}\n`));

process.stdout.write(`\n${c.bold('Next steps (LLM agents):')}\n`);
const steps = [
  `Fill ${c.bold(specPath)} (analyst — replace every [?])`,
  `Fill ${c.bold(designPath)} (architect — accept before code)`,
  `Author ${c.bold(`src/shared/${name}-reshape.ts`)} (canonical projection, jeśli potrzebne)`,
  `Add domain tools via ${c.bold(`npm run workflow:add-tool -- --connector=${name} --tool=<name> ...`)}`,
  `Update package.json + README per reminders above`,
  `Run ${c.bold('npm run verify')}`,
];
steps.forEach((s, i) => process.stdout.write(`  ${i + 1}. ${s}\n`));

process.exit(0);

// ── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const kv = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (!kv) continue;
    out[kv[1]] = kv[2] ?? true;
  }
  return out;
}

function writeIfMissing(rel, content) {
  const abs = nodePath.resolve(ROOT, rel);
  if (existsSync(abs)) {
    process.stdout.write(`  ${c.warn('⚠')} exists: ${rel} (skip)\n`);
    return;
  }
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  process.stdout.write(`  ${c.ok('✓')} wrote ${rel}\n`);
}

function pascal(s) {
  return s
    .split('-')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}
