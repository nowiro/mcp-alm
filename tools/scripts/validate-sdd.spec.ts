/**
 * Integration tests for `tools/scripts/validate-sdd.mjs`.
 *
 * Spawns the real CLI against fixture trees in a temp dir and asserts exit code +
 * message. Cross-platform: uses `process.execPath`, `os.tmpdir()`, `node:path`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./validate-sdd.mjs', import.meta.url));

function runIn(dir: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function writeSpec(dir: string, slug: string, body: string): void {
  mkdirSync(join(dir, 'docs', 'specs', slug), { recursive: true });
  writeFileSync(join(dir, 'docs', 'specs', slug, 'spec.md'), body);
}

describe('validate-sdd CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdd-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes vacuously when there are no SDD artifacts', () => {
    expect(runIn(dir).code).toBe(0);
  });

  it('passes a well-formed draft spec', () => {
    writeSpec(
      dir,
      'foo',
      `---\nid: spec.foo\ntitle: foo\ntype: spec\nstatus: draft\n---\n\n## Acceptance criteria\n\n[?] tbd.\n`,
    );
    expect(runIn(dir).code).toBe(0);
  });

  it('fails when the spec id does not match its folder', () => {
    writeSpec(
      dir,
      'foo',
      `---\nid: spec.bar\ntitle: foo\ntype: spec\nstatus: draft\n---\n\n## Acceptance criteria\n\nok.\n`,
    );
    const r = runIn(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('spec.foo');
  });

  it('fails a non-draft spec that still has [?] placeholders', () => {
    writeSpec(
      dir,
      'foo',
      `---\nid: spec.foo\ntitle: foo\ntype: spec\nstatus: clarified\n---\n\n## Acceptance criteria\n\n[?] still open.\n`,
    );
    const r = runIn(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[?]');
  });

  it('fails a non-draft spec missing the required section', () => {
    writeSpec(dir, 'foo', `---\nid: spec.foo\ntitle: foo\ntype: spec\nstatus: draft\n---\n\n# Spec\n\nbrak sekcji.\n`);
    const r = runIn(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Acceptance criteria');
  });

  it('fails a new-tool plan whose spec is missing', () => {
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'plans', '2026-01-01-new-tool-foo.md'),
      `---\nid: plan.new-tool.foo\ntitle: New tool — foo\ntype: plan\n---\n\n| id | title | agent | done_when |\n| --- | --- | --- | --- |\n| T001 | x | analyst | y |\n`,
    );
    const r = runIn(dir);
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain('missing');
  });

  it('fails a generic <verb> plan whose spec is missing (generalized traceability)', () => {
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'plans', '2026-01-01-new-connector-asana.md'),
      `---\nid: plan.new-connector.asana\ntitle: New connector — asana\ntype: plan\n---\n\n| id | title | agent | done_when |\n| --- | --- | --- | --- |\n| T001 | x | analyst | y |\n`,
    );
    const r = runIn(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('asana');
  });

  it('skips a free-form plan with no frontmatter (warn, exit 0)', () => {
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'plans', '2026-01-01-notes.md'), `# Working notes\n\nfree-form, no frontmatter.\n`);
    const r = runIn(dir);
    expect(r.code).toBe(0);
    expect(r.out.toLowerCase()).toContain('free-form');
  });
});
