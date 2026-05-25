/**
 * Testy dla `extract-runtime.ts` — wspólne helpery DRY dla pipeline'ów.
 *   - schematy Zod (snapshotName, renderFormats)
 *   - parseCursorFromLink (Confluence v2)
 *   - writePipelineOutputs / writeManifest — wokół tmp directory
 *   - runIfMain — nie test (top-level side effect, integration territory)
 *   - createScriptLogger — basic smoke
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildManifest,
  createScriptLogger,
  loadJsonConfig,
  parseCursorFromLink,
  renderFormatsSchema,
  snapshotNameSchema,
  writeManifest,
  writePipelineOutputs,
} from './extract-runtime.js';
import { z } from 'zod';

describe('snapshotNameSchema', () => {
  it('accepts lowercase kebab', () => {
    expect(snapshotNameSchema.parse('active-bugs')).toBe('active-bugs');
    expect(snapshotNameSchema.parse('a')).toBe('a');
    expect(snapshotNameSchema.parse('snap-1-of-2')).toBe('snap-1-of-2');
  });

  it('rejects uppercase, spaces, leading dash', () => {
    expect(() => snapshotNameSchema.parse('ActiveBugs')).toThrow();
    expect(() => snapshotNameSchema.parse('active bugs')).toThrow();
    expect(() => snapshotNameSchema.parse('-leading')).toThrow();
    expect(() => snapshotNameSchema.parse('')).toThrow();
  });

  it('rejects names over 64 chars', () => {
    expect(() => snapshotNameSchema.parse('a'.repeat(65))).toThrow();
  });
});

describe('renderFormatsSchema', () => {
  it('defaults to ["json", "markdown"] when absent', () => {
    expect(renderFormatsSchema.parse(undefined)).toEqual(['json', 'markdown']);
  });

  it('accepts subset', () => {
    expect(renderFormatsSchema.parse(['json'])).toEqual(['json']);
    expect(renderFormatsSchema.parse(['markdown'])).toEqual(['markdown']);
  });

  it('rejects empty array', () => {
    expect(() => renderFormatsSchema.parse([])).toThrow();
  });

  it('rejects unknown format', () => {
    expect(() => renderFormatsSchema.parse(['yaml'])).toThrow();
  });
});

describe('parseCursorFromLink', () => {
  it('extracts cursor from Confluence-style next link', () => {
    expect(parseCursorFromLink('https://example.atlassian.net/wiki/api/v2/pages/123/children?cursor=abc123')).toBe(
      'abc123',
    );
  });

  it('extracts cursor when not the first param', () => {
    expect(parseCursorFromLink('/some/path?limit=50&cursor=xyz789')).toBe('xyz789');
  });

  it('URL-decodes the cursor value', () => {
    expect(parseCursorFromLink('/x?cursor=a%2Fb%3Dc')).toBe('a/b=c');
  });

  it('returns undefined for empty / missing input', () => {
    expect(parseCursorFromLink(undefined)).toBeUndefined();
    expect(parseCursorFromLink('')).toBeUndefined();
  });

  it('returns undefined when link has no cursor param', () => {
    expect(parseCursorFromLink('/x?limit=50')).toBeUndefined();
  });
});

describe('writePipelineOutputs / writeManifest (tmpdir)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'mcp-alm-extract-test-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes both JSON and Markdown when formats requested', async () => {
    const dir = join(tmpRoot, 'snap');
    await writePipelineOutputs({
      dir,
      basename: 'abc-123',
      data: { hello: 'world' },
      markdown: '# Hello',
      formats: ['json', 'markdown'],
    });
    const json = await readFile(join(dir, 'abc-123.json'), 'utf8');
    const md = await readFile(join(dir, 'abc-123.md'), 'utf8');
    expect(JSON.parse(json)).toEqual({ hello: 'world' });
    expect(json.endsWith('\n')).toBe(true);
    expect(md).toBe('# Hello');
  });

  it('writes only JSON when markdown is excluded', async () => {
    const dir = join(tmpRoot, 'snap');
    await writePipelineOutputs({
      dir,
      basename: 'only-json',
      data: { a: 1 },
      markdown: 'should not be written',
      formats: ['json'],
    });
    const json = await readFile(join(dir, 'only-json.json'), 'utf8');
    expect(JSON.parse(json)).toEqual({ a: 1 });
    await expect(readFile(join(dir, 'only-json.md'), 'utf8')).rejects.toThrow();
  });

  it('creates the directory recursively if it does not exist', async () => {
    const dir = join(tmpRoot, 'deep', 'nested', 'snap');
    await writePipelineOutputs({
      dir,
      basename: 'x',
      data: {},
      markdown: '',
      formats: ['json'],
    });
    const json = await readFile(join(dir, 'x.json'), 'utf8');
    expect(JSON.parse(json)).toEqual({});
  });

  it('writeManifest writes _manifest.json with stable serialization', async () => {
    const dir = join(tmpRoot, 'snap');
    await mkdir(dir, { recursive: true });
    const manifest = { snapshot: 'test', count: 5, ids: ['a', 'b', 'c'] };
    await writeManifest(dir, manifest);
    const content = await readFile(join(dir, '_manifest.json'), 'utf8');
    expect(JSON.parse(content)).toEqual(manifest);
    expect(content.endsWith('\n')).toBe(true);
  });

  it('loadJsonConfig reads + validates via Zod', async () => {
    const dir = join(tmpRoot, 'cfg');
    await mkdir(dir, { recursive: true });
    const schema = z.object({ outputDir: z.string(), version: z.number() });
    const configPath = join(dir, 'config.json');
    await writeManifest(dir, { foo: 'bar' });
    // reuse manifest as a json file — write minimal valid config
    const validConfig = { outputDir: './out', version: 1 };
    await writePipelineOutputs({
      dir,
      basename: 'config',
      data: validConfig,
      markdown: '',
      formats: ['json'],
    });
    const loaded = await loadJsonConfig(configPath, schema);
    expect(loaded).toEqual(validConfig);
  });

  it('loadJsonConfig throws on schema mismatch', async () => {
    const dir = join(tmpRoot, 'cfg');
    await mkdir(dir, { recursive: true });
    const schema = z.object({ outputDir: z.string() });
    const configPath = join(dir, 'config.json');
    await writePipelineOutputs({
      dir,
      basename: 'config',
      data: { wrong: 'shape' },
      markdown: '',
      formats: ['json'],
    });
    await expect(loadJsonConfig(configPath, schema)).rejects.toThrow();
  });
});

describe('createScriptLogger', () => {
  it('returns a function that writes prefixed lines to stderr', () => {
    const log = createScriptLogger('test-script');
    expect(typeof log).toBe('function');
    // Sanity — nie testujemy stderr write głębiej (testowanie process.stderr
    // wymagałoby mocka który zaśmieci inne testy). Tu chodzi tylko o smoke.
  });
});

describe('buildManifest', () => {
  const snapshot = { name: 'active-bugs', render: ['json', 'markdown'] as const };

  it('builds envelope with common fields + extras', () => {
    const manifest = buildManifest('extract-jira', '2026-05-22T10:00:00.000Z', snapshot, {
      jql: 'project = X',
      issueCount: 42,
    });

    expect(manifest.snapshot).toBe('active-bugs');
    expect(manifest.runStartedAt).toBe('2026-05-22T10:00:00.000Z');
    expect(manifest.runFinishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.render).toEqual(['json', 'markdown']);
    expect(manifest.tooling.script).toBe('extract-jira');
    expect(manifest.tooling.version).toBeTypeOf('string');
    expect(manifest.jql).toBe('project = X');
    expect(manifest.issueCount).toBe(42);
  });

  it('finished timestamp is >= started timestamp', () => {
    const started = new Date().toISOString();
    const manifest = buildManifest('s', started, snapshot, {});
    expect(new Date(manifest.runFinishedAt).getTime()).toBeGreaterThanOrEqual(new Date(started).getTime());
  });

  it('preserves extras keys; spread allows override (caller responsibility)', () => {
    const manifest = buildManifest('s', '2026-01-01T00:00:00Z', snapshot, {
      type: 'page',
      pageIds: ['1', '2'],
    });
    expect(manifest.type).toBe('page');
    expect(manifest.pageIds).toEqual(['1', '2']);
  });
});
