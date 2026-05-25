/**
 * Unit tests — ADF → Markdown converter.
 */
import { describe, expect, it } from 'vitest';

import { adfToMarkdown, adfToMarkdownSafe, type AdfNode } from './adf.js';

const para = (text: string): AdfNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

describe('adfToMarkdown', () => {
  it('handles null/undefined/string passthrough', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
    expect(adfToMarkdown('plain')).toBe('plain');
  });

  it('renders a doc with a single paragraph', () => {
    const doc: AdfNode = { type: 'doc', content: [para('Hello world')] };
    expect(adfToMarkdown(doc)).toBe('Hello world');
  });

  it('renders headings with correct level', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] }],
    };
    expect(adfToMarkdown(doc)).toBe('## Title');
  });

  it('clamps heading level to 1..6', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'Big' }] }],
    };
    expect(adfToMarkdown(doc)).toBe('###### Big');
  });

  it('applies marks (strong + em + code + link)', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
            { type: 'text', text: 'code', marks: [{ type: 'code' }] },
            { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x.com' } }] },
          ],
        },
      ],
    };
    const md = adfToMarkdown(doc);
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
    expect(md).toContain('`code`');
    expect(md).toContain('[link](https://x.com)');
  });

  it('renders bullet lists', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para('one')] },
            { type: 'listItem', content: [para('two')] },
          ],
        },
      ],
    };
    const md = adfToMarkdown(doc);
    expect(md).toContain('- one');
    expect(md).toContain('- two');
  });

  it('renders ordered lists with `1.` marker', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          content: [{ type: 'listItem', content: [para('first')] }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toContain('1. first');
  });

  it('renders code block with language', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = 1;' }] }],
    };
    const md = adfToMarkdown(doc);
    expect(md).toContain('```ts');
    expect(md).toContain('const x = 1;');
  });

  it('renders panel with variant marker', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [{ type: 'panel', attrs: { panelType: 'warning' }, content: [para('Mind the gap')] }],
    };
    const md = adfToMarkdown(doc);
    expect(md).toContain('[WARNING]');
    expect(md).toContain('> Mind the gap');
  });

  it('renders mention as @name', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@alice' } }] }],
    };
    expect(adfToMarkdown(doc)).toBe('@alice');
  });

  it('renders inlineCard as link', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://jira/PROJ-1' } }] }],
    };
    expect(adfToMarkdown(doc)).toContain('[https://jira/PROJ-1](https://jira/PROJ-1)');
  });

  it('renders a table with header + body rows', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [para('A')] },
                { type: 'tableHeader', content: [para('B')] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [para('1')] },
                { type: 'tableCell', content: [para('2')] },
              ],
            },
          ],
        },
      ],
    };
    const md = adfToMarkdown(doc);
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('emits diagnostic comment for unknown block', () => {
    const doc: AdfNode = { type: 'doc', content: [{ type: 'futureNode', content: [para('secret')] }] };
    const md = adfToMarkdown(doc);
    expect(md).toContain('<!-- adf:unknown:futureNode -->');
    expect(md).toContain('secret');
  });

  it('handles deep nesting without throwing', () => {
    const deep: AdfNode = { type: 'doc', content: [para('hi')] };
    expect(() => adfToMarkdown(deep)).not.toThrow();
  });
});

describe('adfToMarkdownSafe', () => {
  it('returns undefined for null / undefined / non-object', () => {
    expect(adfToMarkdownSafe(null)).toBeUndefined();
    expect(adfToMarkdownSafe(undefined)).toBeUndefined();
    expect(adfToMarkdownSafe('plain string')).toBeUndefined();
    expect(adfToMarkdownSafe(42)).toBeUndefined();
    expect(adfToMarkdownSafe(true)).toBeUndefined();
  });

  it('returns undefined for valid ADF that renders to empty string', () => {
    expect(adfToMarkdownSafe({ type: 'doc', content: [] })).toBeUndefined();
  });

  it('returns Markdown for non-empty ADF', () => {
    const doc: AdfNode = { type: 'doc', content: [para('hello')] };
    expect(adfToMarkdownSafe(doc)).toBe('hello');
  });

  it('accepts unknown type — TypeScript guards against this but runtime is tolerant', () => {
    const doc = { type: 'doc', content: [para('x')] };
    expect(adfToMarkdownSafe(doc)).toBe('x');
  });
});
