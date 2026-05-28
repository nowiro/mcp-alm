/**
 * Testy dla deterministycznych części `extract-confluence.ts`:
 *   - schema configu (ExtractConfig) — defaulty, walidacja, discriminated union
 *   - renderer Markdown (renderPageMarkdown) — pure function, deterministyczny
 */
import { describe, expect, it } from 'vitest';

import { ExtractConfig, renderPageMarkdown, type ExtractedPage } from './extract-confluence.js';

describe('ExtractConfig (Confluence)', () => {
  it('parses single-page snapshot', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'charter', type: 'page', pageId: '12345' }],
    });
    expect(parsed.outputDir).toBe('./output/confluence');
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'page') throw new Error(`expected page, got ${snap.type}`);
    expect(snap.pageId).toBe('12345');
    expect(snap.render).toEqual(['json', 'markdown']);
  });

  it('parses tree snapshot with defaults', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'tree', type: 'tree', rootPageId: '999' }],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'tree') throw new Error(`expected tree, got ${snap.type}`);
    expect(snap.depth).toBe(3);
    expect(snap.maxPages).toBe(500);
  });

  it('parses label snapshot with optional space', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'rfcs', type: 'label', label: 'rfc', space: 'ENG' }],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'label') throw new Error(`expected label, got ${snap.type}`);
    expect(snap.label).toBe('rfc');
    expect(snap.space).toBe('ENG');
  });

  it('rejects pageId that is not numeric string', () => {
    expect(() => ExtractConfig.parse({ snapshots: [{ name: 'a', type: 'page', pageId: 'abc' }] })).toThrow();
  });

  it('rejects unknown snapshot type', () => {
    expect(() =>
      ExtractConfig.parse({ snapshots: [{ name: 'a', type: 'wildcard' as 'page', pageId: '1' }] }),
    ).toThrow();
  });

  it('rejects depth > 10', () => {
    expect(() =>
      ExtractConfig.parse({ snapshots: [{ name: 'a', type: 'tree', rootPageId: '1', depth: 100 }] }),
    ).toThrow();
  });
});

describe('renderPageMarkdown', () => {
  const minimalPage: ExtractedPage = {
    id: '12345',
    title: 'Team Charter',
    spaceId: 'ENG',
    status: 'current',
    version: 7,
    authorId: 'a-1',
    createdAt: '2025-09-01T10:00:00Z',
    url: 'https://wiki.example.com/pages/12345',
    labels: [],
    ancestors: [],
    comments: [],
    attachments: [],
    childPageIds: [],
  };

  it('produces header with title', () => {
    const md = renderPageMarkdown(minimalPage);
    expect(md).toMatch(/^# Team Charter/);
  });

  it('falls back to "Page <id>" when title missing', () => {
    const md = renderPageMarkdown({ ...minimalPage, title: undefined });
    expect(md).toContain('# Page 12345');
  });

  it('renders primary metadata', () => {
    const md = renderPageMarkdown(minimalPage);
    expect(md).toContain('**ID**: `12345`');
    expect(md).toContain('**Space**: `ENG`');
    expect(md).toContain('**Status**: current');
    expect(md).toContain('**Version**: 7');
    expect(md).toContain('**Created**: 2025-09-01T10:00:00Z');
    expect(md).toContain('**URL**: https://wiki.example.com/pages/12345');
  });

  it('renders labels when present', () => {
    const md = renderPageMarkdown({ ...minimalPage, labels: ['rfc', 'engineering'] });
    expect(md).toContain('**Labels**: rfc, engineering');
  });

  it('omits labels line when empty', () => {
    const md = renderPageMarkdown(minimalPage);
    expect(md).not.toContain('**Labels**:');
  });

  it('renders ancestor path with breadcrumb separator', () => {
    const md = renderPageMarkdown({
      ...minimalPage,
      ancestors: [
        { id: '1', title: 'Engineering' },
        { id: '2', title: 'Handbook' },
      ],
    });
    expect(md).toContain('**Path**: Engineering › Handbook');
  });

  it('renders body section when bodyMd present', () => {
    const md = renderPageMarkdown({ ...minimalPage, bodyMd: '# Section\n\nLorem ipsum.' });
    expect(md).toContain('## Body');
    expect(md).toContain('Lorem ipsum.');
  });

  it('renders comments section', () => {
    const md = renderPageMarkdown({
      ...minimalPage,
      comments: [{ id: 'c1', title: 'Re: charter', createdAt: '2026-01-01T00:00:00Z', bodyMd: 'agree' }],
    });
    expect(md).toContain('## Comments');
    expect(md).toContain('Re: charter — 2026-01-01T00:00:00Z');
    expect(md).toContain('agree');
  });

  it('renders attachments and children', () => {
    const md = renderPageMarkdown({
      ...minimalPage,
      attachments: [{ id: 'a1', title: 'spec.pdf', mediaType: 'application/pdf', fileSize: 1024 }],
      childPageIds: ['child-1', 'child-2'],
    });
    expect(md).toContain('## Attachments');
    expect(md).toContain('**spec.pdf**');
    expect(md).toContain('## Children');
    expect(md).toContain('`child-1`');
    expect(md).toContain('`child-2`');
  });

  it('is deterministic — identical input produces identical output', () => {
    const page: ExtractedPage = {
      ...minimalPage,
      bodyMd: 'body content',
      labels: ['rfc'],
      comments: [{ id: 'c1', title: 't', createdAt: '2026-01-01', bodyMd: 'x' }],
    };
    expect(renderPageMarkdown(page)).toBe(renderPageMarkdown(page));
  });
});
