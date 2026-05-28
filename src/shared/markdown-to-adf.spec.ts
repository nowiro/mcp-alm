import { describe, expect, it } from 'vitest';

import { markdownToAdf } from './markdown-to-adf.js';

describe('markdownToAdf', () => {
  it('zwraca pusty document dla pustego inputu', () => {
    const doc = markdownToAdf('');
    expect(doc).toEqual({ type: 'doc', version: 1, content: [] });
  });

  it('splituje paragrafy po pustych liniach', () => {
    const doc = markdownToAdf('First paragraph.\n\nSecond paragraph.');
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'First paragraph.' }] });
    expect(doc.content[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph.' }] });
  });

  it('składa kilka linii bez pustej linii w jeden paragraf', () => {
    const doc = markdownToAdf('Line one\nLine two\nLine three');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Line one Line two Line three' }],
    });
  });

  it('rozpoznaje heading level 1-6', () => {
    const doc = markdownToAdf('# H1\n\n## H2\n\n### H3\n\n###### H6');
    expect(doc.content).toHaveLength(4);
    expect(doc.content[0]).toEqual({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'H1' }],
    });
    expect(doc.content[1]?.attrs).toEqual({ level: 2 });
    expect(doc.content[2]?.attrs).toEqual({ level: 3 });
    expect(doc.content[3]?.attrs).toEqual({ level: 6 });
  });

  it('łączy kolejne `- item` w jeden bulletList', () => {
    const doc = markdownToAdf('- one\n- two\n- three');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]?.type).toBe('bulletList');
    expect(doc.content[0]?.content).toHaveLength(3);
    expect(doc.content[0]?.content?.[0]).toEqual({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
    });
  });

  it('akceptuje też `* item` jako bullet', () => {
    const doc = markdownToAdf('* alpha\n* beta');
    expect(doc.content[0]?.type).toBe('bulletList');
    expect(doc.content[0]?.content).toHaveLength(2);
  });

  it('łączy kolejne `1. item` w orderedList', () => {
    const doc = markdownToAdf('1. first\n2. second\n3. third');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]?.type).toBe('orderedList');
    expect(doc.content[0]?.content).toHaveLength(3);
    expect(doc.content[0]?.content?.[1]).toEqual({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
    });
  });

  it('rozpoznaje fenced code block z language', () => {
    const doc = markdownToAdf('```typescript\nconst x = 1;\nconsole.log(x);\n```');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'typescript' },
      content: [{ type: 'text', text: 'const x = 1;\nconsole.log(x);' }],
    });
  });

  it('rozpoznaje fenced code block bez language (zero attrs)', () => {
    const doc = markdownToAdf('```\nplain text\n```');
    expect(doc.content[0]).toEqual({
      type: 'codeBlock',
      content: [{ type: 'text', text: 'plain text' }],
    });
  });

  it('miks bloków: heading + paragraph + list + code', () => {
    const md = ['# Title', '', 'Intro paragraph.', '', '- one', '- two', '', '```js', 'foo()', '```'].join('\n');
    const doc = markdownToAdf(md);
    expect(doc.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'codeBlock']);
  });

  it('niedomknięty fence — body do końca, codeBlock nadal zwrócony', () => {
    const doc = markdownToAdf('```\nunclosed');
    expect(doc.content[0]?.type).toBe('codeBlock');
    expect(doc.content[0]?.content?.[0]?.text).toBe('unclosed');
  });

  it('zachowuje deterministic shape (LLM-agnostic)', () => {
    const md = '# A\n\nB\n\n- c';
    const a = markdownToAdf(md);
    const b = markdownToAdf(md);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
