#!/usr/bin/env node
/**
 * validate-sdd.mjs — cross-artifact Spec-Driven-Development consistency gate.
 *
 * CANONICAL SOURCE: mcp-workspace/tools/scripts/validate-sdd.mjs — keep the copies in
 * nowiro/mcp-alm and nowiro/mcp-devtools in sync with this file. See docs/sdd/methodology.md.
 *
 * Deterministic STRUCTURAL checks over docs/specs/ + docs/plans/ (the artifacts a
 * `workflow:*` scaffolder emits). The SEMANTIC layer — does the plan actually cover the
 * spec's acceptance criteria, are there contradictions, has the code drifted — lives in
 * the `/analyze` prompt, which runs this script first.
 *
 * Errors (→ exit 1):
 *   - every docs/specs/<slug>/spec.md has frontmatter `type: spec` + `id: spec.<slug>`
 *     (the id slug must equal the folder) and the required section(s).
 *   - every docs/plans/*.md that HAS frontmatter carries `type: plan` + `id` and a task
 *     table whose header is `id | title | agent | done_when`.
 *   - traceability: a `plan.<verb>.<slug>` plan must have a matching docs/specs/<slug>/spec.md.
 *   - a spec whose status is NOT draft must not still contain `[?]` placeholders.
 *
 * Warnings (printed, exit 0 — legitimate WIP):
 *   - a docs/plans/*.md with NO frontmatter is treated as a free-form working note (skipped).
 *   - a spec folder with no plan referencing its slug.
 *
 * Passes vacuously when there are no SDD artifacts yet. Used by `npm run sdd:check`
 * and (via `verify`) before push.
 *
 * Exits 0 on success, 1 on any error.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const errors = [];
const warnings = [];

const must = (cond, msg) => {
  if (!cond) errors.push(msg);
};

const SPECS_DIR = 'docs/specs';
const PLANS_DIR = 'docs/plans';
const REQUIRED_SPEC_SECTIONS = ['## Acceptance criteria'];

// plan.<verb>.<slug> — verb is any kebab token (new-tool, new-connector, feature, …),
// slug is the trailing segment and must map to docs/specs/<slug>/spec.md.
const PLAN_ID_RE = /^plan\.[a-z0-9-]+\.([a-z0-9-]+)$/;

async function frontmatter(file) {
  const txt = await readFile(file, 'utf8');
  const fm = txt.match(/^---\n([\s\S]+?)\n---/);
  return fm ? fm[1] : null;
}

function fmValue(fm, key) {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

async function listDirs(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listMd(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
}

async function main() {
  const specSlugs = await listDirs(SPECS_DIR);
  const planFiles = await listMd(PLANS_DIR);

  if (specSlugs.length === 0 && planFiles.length === 0) {
    console.log(`✓ SDD: no spec/plan artifacts yet — nothing to check (${SPECS_DIR}, ${PLANS_DIR} empty)`);
    process.exit(0);
  }

  // Slugs that a scaffolded plan claims to implement — used for reverse traceability.
  const planReferencedSlugs = new Set();

  // ── specs ──
  for (const slug of specSlugs) {
    const specFile = resolve(SPECS_DIR, slug, 'spec.md');
    if (!existsSync(specFile)) {
      errors.push(`${SPECS_DIR}/${slug}/: missing spec.md`);
      continue;
    }
    const txt = await readFile(specFile, 'utf8');
    const fm = await frontmatter(specFile);
    must(fm, `${specFile}: missing YAML frontmatter`);
    if (fm) {
      const type = fmValue(fm, 'type');
      const id = fmValue(fm, 'id');
      const status = fmValue(fm, 'status');
      must(type === 'spec', `${specFile}: frontmatter "type" must be "spec" (got ${type ?? 'none'})`);
      must(id === `spec.${slug}`, `${specFile}: frontmatter "id" must be "spec.${slug}" (got ${id ?? 'none'})`);
      if (status && status !== 'draft' && /\[\?\]/.test(txt)) {
        errors.push(
          `${specFile}: status is "${status}" but still has [?] placeholders — resolve them or set status: draft`,
        );
      }
    }
    for (const section of REQUIRED_SPEC_SECTIONS) {
      must(txt.includes(section), `${specFile}: missing required section "${section}"`);
    }
  }

  // ── plans ──
  for (const name of planFiles) {
    const planFile = resolve(PLANS_DIR, name);
    const txt = await readFile(planFile, 'utf8');
    const fm = await frontmatter(planFile);
    if (!fm) {
      warnings.push(`${planFile}: no frontmatter — treated as a free-form working note (not SDD-validated)`);
      continue;
    }
    const type = fmValue(fm, 'type');
    const id = fmValue(fm, 'id');
    must(type === 'plan', `${planFile}: frontmatter "type" must be "plan" (got ${type ?? 'none'})`);
    must(id, `${planFile}: frontmatter missing "id"`);
    const hasTaskTable = /\|\s*id\s*\|\s*title\s*\|\s*agent\s*\|\s*done_when\s*\|/i.test(txt);
    must(hasTaskTable, `${planFile}: missing task table with header "id | title | agent | done_when"`);
    const m = id ? id.match(PLAN_ID_RE) : null;
    if (m) {
      const slug = m[1];
      planReferencedSlugs.add(slug);
      if (!existsSync(resolve(SPECS_DIR, slug, 'spec.md'))) {
        errors.push(`${planFile}: plan references slug "${slug}" but ${SPECS_DIR}/${slug}/spec.md is missing`);
      }
    }
  }

  // ── reverse traceability (warn — a spec without a plan is legitimate WIP) ──
  for (const slug of specSlugs) {
    if (!planReferencedSlugs.has(slug)) {
      warnings.push(`${SPECS_DIR}/${slug}/: spec has no plan referencing it (plan.<verb>.${slug}) — WIP?`);
    }
  }

  for (const w of warnings) console.warn('  ⚠ ' + w);

  if (errors.length === 0) {
    const tail = warnings.length ? ` · ${warnings.length} warning(s)` : '';
    console.log(`✓ SDD cross-artifact check passed — ${specSlugs.length} spec(s) · ${planFiles.length} plan(s)${tail}`);
    process.exit(0);
  }
  console.error('✗ SDD cross-artifact check failed:\n');
  for (const e of errors) console.error(' - ' + e);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
