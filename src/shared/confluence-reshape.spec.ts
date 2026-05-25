import { describe, expect, it } from 'vitest';

import { reshapeConfluencePage } from './confluence-reshape.js';

describe('reshapeConfluencePage', () => {
  it('returns id + title for a minimal page', () => {
    const out = reshapeConfluencePage({ id: '42', title: 'Home' });
    expect(out.id).toBe('42');
    expect(out.title).toBe('Home');
    expect(out.bodyMd).toBeUndefined();
    expect(out.mode).toBe('full');
  });

  it('renders an ADF body to Markdown', () => {
    const out = reshapeConfluencePage({
      id: '42',
      title: 'Home',
      body: {
        atlas_doc_format: {
          representation: 'atlas_doc_format',
          value: {
            type: 'doc',
            content: [
              { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Welcome' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Hello, world.' }] },
            ],
          },
        },
      },
    });
    expect(out.bodyMd).toContain('# Welcome');
    expect(out.bodyMd).toContain('Hello, world.');
    expect(out.truncated).toBeUndefined();
  });

  it('accepts ADF supplied as a JSON-string (Confluence v2 sometimes does this)', () => {
    const out = reshapeConfluencePage({
      id: '42',
      title: 'Home',
      body: {
        atlas_doc_format: {
          representation: 'atlas_doc_format',
          value: JSON.stringify({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inlined' }] }],
          }),
        },
      },
    });
    expect(out.bodyMd).toContain('Inlined');
  });

  it('truncates bodies above maxChars and flags them', () => {
    const longText = 'x'.repeat(50_000);
    const out = reshapeConfluencePage(
      {
        id: '42',
        title: 'Big page',
        body: {
          atlas_doc_format: {
            representation: 'atlas_doc_format',
            value: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }],
            },
          },
        },
      },
      { maxChars: 2000 },
    );
    expect(out.truncated).toBe(true);
    expect(out.truncatedAtChars).toBe(2000);
    expect(out.bodyMd?.endsWith('…[truncated]')).toBe(true);
  });

  it('falls back to raw storage body when ADF is absent (and never crashes)', () => {
    const out = reshapeConfluencePage({
      id: '42',
      title: 'Legacy page',
      body: {
        storage: { representation: 'storage', value: '<p>raw html</p>' },
      },
    });
    expect(out.bodyMd).toBe('<p>raw html</p>');
  });

  it('exposes version + status when present', () => {
    const out = reshapeConfluencePage({
      id: '42',
      title: 'Home',
      status: 'current',
      version: { number: 7 },
    });
    expect(out.status).toBe('current');
    expect(out.version).toBe(7);
  });

  it('builds a webui url from _links.base + _links.webui', () => {
    const out = reshapeConfluencePage({
      id: '42',
      title: 'Home',
      _links: { base: 'https://acme.atlassian.net/wiki', webui: '/spaces/X/pages/42' },
    });
    expect(out.url).toBe('https://acme.atlassian.net/wiki/spaces/X/pages/42');
  });

  it('ignores a garbled ADF value rather than throwing', () => {
    const out = reshapeConfluencePage({
      id: '42',
      title: 'Home',
      body: {
        atlas_doc_format: { representation: 'atlas_doc_format', value: 'not-json {' },
      },
    });
    expect(out.bodyMd).toBeUndefined();
  });

  it('summary mode returns the intro + headings instead of the full body', () => {
    const longIntro = 'Lorem ipsum '.repeat(200); // > 500 chars
    const out = reshapeConfluencePage(
      {
        id: '42',
        title: 'Handbook',
        body: {
          atlas_doc_format: {
            representation: 'atlas_doc_format',
            value: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: longIntro }] },
                { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'First' }] },
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Subsection' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'tail copy' }] },
              ],
            },
          },
        },
      },
      { mode: 'summary' },
    );
    expect(out.mode).toBe('summary');
    expect(out.headings).toEqual(['# First', '## Subsection']);
    expect(out.bodyMd?.length).toBeLessThanOrEqual(600);
    expect(out.truncated).toBe(true);
    expect(out.truncatedAtChars).toBe(500);
  });

  it('summary mode on a short page keeps the whole intro and never flags truncation', () => {
    const out = reshapeConfluencePage(
      {
        id: '42',
        title: 'Tiny',
        body: {
          atlas_doc_format: {
            representation: 'atlas_doc_format',
            value: {
              type: 'doc',
              content: [
                { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Top' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'short' }] },
              ],
            },
          },
        },
      },
      { mode: 'summary' },
    );
    expect(out.mode).toBe('summary');
    expect(out.headings).toEqual(['# Top']);
    expect(out.truncated).toBeUndefined();
  });

  it('exposes mode in the canonical shape', () => {
    const out = reshapeConfluencePage({ id: '42', title: 'Home' }, { mode: 'full' });
    expect(out.mode).toBe('full');
  });
});
