/**
 * Markdown → ADF (Atlassian Document Format) converter.
 *
 * Wsparcie (wystarcza dla 95% Confluence `create_page` / `update_page` use cases):
 *   - Paragrafy (oddzielone pustymi liniami)
 *   - Heading `# … ######` (ATX-style, levels 1-6)
 *   - Bullet list `- item` lub `* item`
 *   - Ordered list `1. item`, `2. item`, …
 *   - Fenced code block ` ```optional-lang\n…\n``` `
 *
 * Co NIE jest wspierane (fall back na plain paragraph z literalnym tekstem):
 *   - Inline formatting (bold / italic / link / inline code)
 *   - Tables, panels, mentions
 *   - Nested lists, blockquotes, horizontal rules
 *
 * Dla zaawansowanego MD agent może dostarczyć raw ADF JSON jako parametr toola
 * (`bodyAdf?`). Ten konwerter pokrywa basic Markdown który Copilot Chat
 * najczęściej generuje, bez zewnętrznego markdown parsera (Node stdlib only,
 * zero deps).
 *
 * @see src/shared/adf.ts — odwrotna konwersja (ADF → Markdown)
 */
import type { AdfNode } from './adf.js';

export interface AdfDoc {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: AdfNode[];
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BULLET_RE = /^[-*]\s+(.+)$/;
const ORDERED_RE = /^\d+\.\s+(.+)$/;
const CODE_FENCE_RE = /^```(.*)$/;

type LineKind = 'blank' | 'heading' | 'bullet' | 'ordered' | 'fence' | 'text';

interface ClassifiedLine {
  readonly kind: LineKind;
  readonly raw: string;
}

function classify(line: string): ClassifiedLine {
  const trimmed = line.trim();
  if (trimmed === '') return { kind: 'blank', raw: line };
  if (CODE_FENCE_RE.test(trimmed)) return { kind: 'fence', raw: line };
  if (HEADING_RE.test(trimmed)) return { kind: 'heading', raw: line };
  if (BULLET_RE.test(trimmed)) return { kind: 'bullet', raw: line };
  if (ORDERED_RE.test(trimmed)) return { kind: 'ordered', raw: line };
  return { kind: 'text', raw: line };
}

function textNode(text: string): AdfNode {
  return { type: 'text', text };
}

function paragraphNode(text: string): AdfNode {
  return { type: 'paragraph', content: [textNode(text)] };
}

function headingNode(line: string): AdfNode {
  const match = HEADING_RE.exec(line.trim());
  // Caller verified HEADING_RE matches — defensive fallback.
  if (!match) return paragraphNode(line);
  const hashes = match[1];
  const text = match[2];
  if (hashes === undefined || text === undefined) return paragraphNode(line);
  return {
    type: 'heading',
    attrs: { level: hashes.length },
    content: [textNode(text.trim())],
  };
}

function listItemNode(text: string): AdfNode {
  return {
    type: 'listItem',
    content: [paragraphNode(text)],
  };
}

function buildBulletList(lines: readonly string[]): AdfNode {
  const items = lines.map((line) => {
    const match = BULLET_RE.exec(line.trim());
    const text = match?.[1]?.trim() ?? line.trim();
    return listItemNode(text);
  });
  return { type: 'bulletList', content: items };
}

function buildOrderedList(lines: readonly string[]): AdfNode {
  const items = lines.map((line) => {
    const match = ORDERED_RE.exec(line.trim());
    const text = match?.[1]?.trim() ?? line.trim();
    return listItemNode(text);
  });
  return { type: 'orderedList', content: items };
}

function buildCodeBlock(fenceLine: string, bodyLines: readonly string[]): AdfNode {
  const match = CODE_FENCE_RE.exec(fenceLine.trim());
  const language = match?.[1]?.trim() ?? '';
  const text = bodyLines.join('\n');
  return {
    type: 'codeBlock',
    ...(language ? { attrs: { language } } : {}),
    content: [textNode(text)],
  };
}

function buildParagraph(lines: readonly string[]): AdfNode {
  return paragraphNode(lines.join(' ').trim());
}

/**
 * Convert Markdown to ADF document. Always returns valid `{ type: 'doc', … }`,
 * never throws — empty input yields `{ content: [] }`.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.split('\n');
  const content: AdfNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const lineRaw = lines[i];
    if (lineRaw === undefined) {
      i += 1;
      continue;
    }
    const { kind } = classify(lineRaw);

    if (kind === 'blank') {
      i += 1;
      continue;
    }

    if (kind === 'fence') {
      // Open fence — scan to closing fence (or end of input).
      const fence = lineRaw;
      const bodyStart = i + 1;
      let bodyEnd = bodyStart;
      while (bodyEnd < lines.length) {
        const body = lines[bodyEnd];
        if (body !== undefined && CODE_FENCE_RE.test(body.trim())) break;
        bodyEnd += 1;
      }
      content.push(buildCodeBlock(fence, lines.slice(bodyStart, bodyEnd)));
      i = bodyEnd + 1; // skip closing fence
      continue;
    }

    if (kind === 'heading') {
      content.push(headingNode(lineRaw));
      i += 1;
      continue;
    }

    if (kind === 'bullet') {
      const start = i;
      while (i < lines.length) {
        const next = lines[i];
        if (next === undefined || classify(next).kind !== 'bullet') break;
        i += 1;
      }
      content.push(buildBulletList(lines.slice(start, i)));
      continue;
    }

    if (kind === 'ordered') {
      const start = i;
      while (i < lines.length) {
        const next = lines[i];
        if (next === undefined || classify(next).kind !== 'ordered') break;
        i += 1;
      }
      content.push(buildOrderedList(lines.slice(start, i)));
      continue;
    }

    // kind === 'text' — accumulate consecutive non-blank, non-block lines.
    const start = i;
    while (i < lines.length) {
      const next = lines[i];
      if (next === undefined) break;
      const k = classify(next).kind;
      if (k !== 'text') break;
      i += 1;
    }
    content.push(buildParagraph(lines.slice(start, i)));
  }

  return { type: 'doc', version: 1, content };
}
