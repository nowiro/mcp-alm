/**
 * ADF (Atlassian Document Format) → Markdown converter.
 *
 * ADF is the JSON document format used by Jira issue descriptions / comments
 * and Confluence page bodies (when the API is asked for ADF instead of HTML).
 * Spec: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 *
 * Why convert here:
 *   - LLMs read Markdown well. ADF JSON is verbose noise.
 *   - Markdown also serialises losslessly through the MCP protocol.
 *
 * Coverage (the ~95 % path):
 *   - paragraph · heading (1–6) · bulletList · orderedList · listItem
 *   - text · marks (strong · em · code · strike · link)
 *   - codeBlock (with language hint)
 *   - blockquote · rule
 *   - panel (info / warning / error / success / note)
 *   - mention (@displayName) · emoji (:short_name:)
 *   - inlineCard (Jira issue link) · table · tableRow · tableHeader · tableCell
 *   - mediaSingle / mediaGroup / media (returns alt text + URL)
 *
 * Unknown nodes degrade gracefully — emit any inline text we can find and a
 * `<!-- adf:unknown:<type> -->` HTML comment so problem nodes are debuggable.
 */

export interface AdfMark {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
}

export interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly content?: readonly AdfNode[];
  readonly marks?: readonly AdfMark[];
  readonly attrs?: Record<string, unknown>;
}

/**
 * Convert ADF (or a plain string, or null/undefined) to Markdown.
 * Always returns a string — never throws.
 */
export function adfToMarkdown(input: AdfNode | string | null | undefined): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || !('type' in input)) return '';
  return walkBlock(input).trim();
}

/**
 * Tolerant wrapper nad `adfToMarkdown` dla wartości `unknown` (typowo z
 * surowych API responses). Zwraca `undefined` zamiast `''` dla pustego /
 * niepoprawnego inputu, żeby pasowało do wzorca `...(value ? { key: value } : {})`.
 */
export function adfToMarkdownSafe(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const md = adfToMarkdown(raw as AdfNode);
  return md.length > 0 ? md : undefined;
}

// ── Block-level walker ──────────────────────────────────────────────────────

function walkBlock(node: AdfNode): string {
  switch (node.type) {
    case 'doc': {
      return joinBlocks(node.content);
    }
    case 'paragraph': {
      return walkInline(node.content) + '\n';
    }
    case 'heading': {
      const level = clampLevel(node.attrs?.['level']);
      return `${'#'.repeat(level)} ${walkInline(node.content)}\n`;
    }
    case 'bulletList': {
      return renderList(node.content, '-') + '\n';
    }
    case 'orderedList': {
      return renderList(node.content, '1.') + '\n';
    }
    case 'codeBlock': {
      const language = typeof node.attrs?.['language'] === 'string' ? node.attrs['language'] : '';
      return `\`\`\`${language}\n${joinText(node.content)}\n\`\`\`\n`;
    }
    case 'blockquote': {
      const inner = joinBlocks(node.content);
      const quoted = inner
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n');
      // Plain string ops — no regex backtracking risk.
      return `${quoted.trimEnd()}\n`;
    }
    case 'rule': {
      return '\n---\n';
    }
    case 'panel': {
      const variant = typeof node.attrs?.['panelType'] === 'string' ? node.attrs['panelType'] : 'info';
      const inner = joinBlocks(node.content).trim();
      return (
        `> **[${variant.toUpperCase()}]**\n` +
        inner
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n') +
        '\n'
      );
    }
    case 'table': {
      return renderTable(node) + '\n';
    }
    case 'mediaSingle':
    case 'mediaGroup': {
      return walkInline(node.content) + '\n';
    }
    default: {
      // Unknown block: emit any inline text + diagnostic comment.
      const inline = walkInline(node.content);
      return inline ? `${inline}\n<!-- adf:unknown:${node.type} -->\n` : `<!-- adf:unknown:${node.type} -->\n`;
    }
  }
}

function joinBlocks(content: readonly AdfNode[] | undefined): string {
  if (!content || content.length === 0) return '';
  return content.map((child) => walkBlock(child)).join('\n');
}

// ── Inline-level walker ─────────────────────────────────────────────────────

function walkInline(content: readonly AdfNode[] | undefined): string {
  if (!content || content.length === 0) return '';
  return content.map((node) => inlineNode(node)).join('');
}

function inlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text': {
      return applyMarks(node.text ?? '', node.marks);
    }
    case 'hardBreak': {
      return '  \n';
    }
    case 'mention': {
      const name = typeof node.attrs?.['text'] === 'string' ? node.attrs['text'] : 'user';
      return `@${name.replace(/^@/, '')}`;
    }
    case 'emoji': {
      const short = typeof node.attrs?.['shortName'] === 'string' ? node.attrs['shortName'] : '';
      return short || '';
    }
    case 'inlineCard': {
      const url = typeof node.attrs?.['url'] === 'string' ? node.attrs['url'] : '';
      return url ? `[${url}](${url})` : '';
    }
    case 'media': {
      const alt = typeof node.attrs?.['alt'] === 'string' ? node.attrs['alt'] : 'attachment';
      const id = typeof node.attrs?.['id'] === 'string' ? node.attrs['id'] : '';
      return `![${alt}](attachment://${id})`;
    }
    default: {
      // Unknown inline: fall back to any text content.
      return walkInline(node.content) || (typeof node.text === 'string' ? node.text : '');
    }
  }
}

function applyMarks(text: string, marks: readonly AdfMark[] | undefined): string {
  if (!marks || marks.length === 0) return text;
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong': {
        out = `**${out}**`;
        break;
      }
      case 'em': {
        out = `*${out}*`;
        break;
      }
      case 'code': {
        out = `\`${out}\``;
        break;
      }
      case 'strike': {
        out = `~~${out}~~`;
        break;
      }
      case 'link': {
        const href = typeof mark.attrs?.['href'] === 'string' ? mark.attrs['href'] : '#';
        out = `[${out}](${href})`;
        break;
      }
      default: {
        // unknown mark — leave text as-is
        break;
      }
    }
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clampLevel(level: unknown): number {
  if (typeof level !== 'number') return 1;
  return Math.max(1, Math.min(6, Math.round(level)));
}

function joinText(content: readonly AdfNode[] | undefined): string {
  if (!content) return '';
  return content.map((node) => (node.type === 'text' ? (node.text ?? '') : walkInline(node.content))).join('');
}

function renderList(items: readonly AdfNode[] | undefined, marker: string): string {
  if (!items) return '';
  return items
    .filter((item) => item.type === 'listItem')
    .map((item) => {
      const inner = joinBlocks(item.content).trim();
      const lines = inner.split('\n');
      return (
        `${marker} ${lines[0] ?? ''}` +
        (lines.length > 1
          ? '\n' +
            lines
              .slice(1)
              .map((l) => `  ${l}`)
              .join('\n')
          : '')
      );
    })
    .join('\n');
}

function renderTable(table: AdfNode): string {
  const rows = (table.content ?? []).filter((node): node is AdfNode => node.type === 'tableRow');
  if (rows.length === 0) return '';

  const cells: string[][] = rows.map((row) =>
    (row.content ?? []).map((cell) => joinBlocks(cell.content).trim().replaceAll(/\n+/g, ' ')),
  );

  const header = cells[0] ?? [];
  const rest = cells.slice(1);
  const separator = header.map(() => '---');

  return [renderRow(header), renderRow(separator), ...rest.map((row) => renderRow(row))].join('\n');
}

function renderRow(columns: readonly string[]): string {
  return `| ${columns.join(' | ')} |`;
}
