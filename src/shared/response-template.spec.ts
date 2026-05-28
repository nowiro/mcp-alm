import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clearCache,
  loadTemplate,
  parseTemplate,
  renderTemplate,
  setTemplatesRoot,
  templateResponse,
} from './response-template.js';

const TMP = nodePath.join(tmpdir(), 'mcp-alm-response-template-spec');

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  setTemplatesRoot(TMP);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  clearCache();
});

function write(name: string, body: string): void {
  writeFileSync(nodePath.join(TMP, `${name}.md`), body, 'utf8');
  clearCache();
}

describe('parseTemplate', () => {
  it('parses scalar + list frontmatter', () => {
    const parsed = parseTemplate(`---\nid: x\nvars:\n  - a\n  - b\n---\nbody`, 'inline');
    expect(parsed.frontmatter.id).toBe('x');
    expect(parsed.frontmatter.vars).toEqual(['a', 'b']);
    expect(parsed.body).toBe('body');
  });

  it('treats missing frontmatter as empty', () => {
    const parsed = parseTemplate('# raw body', 'inline');
    expect(parsed.body).toBe('# raw body');
  });

  it('tolerates CRLF line endings', () => {
    const parsed = parseTemplate(`---\r\nid: y\r\n---\r\nbody`, 'inline');
    expect(parsed.frontmatter.id).toBe('y');
    expect(parsed.body).toBe('body');
  });
});

describe('renderTemplate', () => {
  it('substitutes scalar vars with default fallback', () => {
    write('scalar', '---\nid: s\n---\nhello {{ name | default:"world" }}');
    expect(renderTemplate('scalar', { name: 'jane' })).toBe('hello jane');
    expect(renderTemplate('scalar', {})).toBe('hello world');
  });

  it('walks dot paths', () => {
    write('dot', '---\nid: d\n---\n{{ user.profile.email }}');
    expect(renderTemplate('dot', { user: { profile: { email: 'a@b.com' } } })).toBe('a@b.com');
  });

  it('expands {{#each}} with this-scoped fields', () => {
    write('loop', '---\nid: l\n---\n{{#each items}}- {{ this.label }}\n{{/each}}');
    const out = renderTemplate('loop', { items: [{ label: 'a' }, { label: 'b' }] });
    expect(out).toBe('- a\n- b\n');
  });

  it('skips {{#if}} blocks when falsy / empty', () => {
    write('cond', '---\nid: c\n---\n{{#if items}}has items{{/if}}{{#if missing}}nope{{/if}}');
    expect(renderTemplate('cond', { items: [1] })).toBe('has items');
    expect(renderTemplate('cond', { items: [] })).toBe('');
  });

  it('renders nested loops', () => {
    write(
      'nested',
      '---\nid: n\n---\n{{#each groups}}{{ this.name }}:{{#each this.items}} {{ this }}{{/each}}\n{{/each}}',
    );
    const out = renderTemplate('nested', {
      groups: [
        { name: 'g1', items: ['a', 'b'] },
        { name: 'g2', items: ['c'] },
      ],
    });
    expect(out).toBe('g1: a b\ng2: c\n');
  });

  it('throws when template is missing', () => {
    expect(() => renderTemplate('nonexistent', {})).toThrow(/missing templates/);
  });
});

describe('templateResponse', () => {
  it('wraps the rendered string in ToolResponse envelope with _meta', () => {
    write('env', '---\nid: e\n---\nhi {{ name }}');
    const result = templateResponse(
      'env',
      { name: 'team' },
      {
        correlationId: 'cid',
        server: 'srv',
        tool: 'tl',
      },
    );
    expect(result.data).toBe('hi team');
    expect(result._meta.tokensEstimate).toBeGreaterThan(0);
    expect(result._meta.correlationId).toBe('cid');
  });

  it('honours dataOverride (template becomes the human mirror)', () => {
    write('mirror', '---\nid: m\n---\nhuman view');
    const result = templateResponse('mirror', {}, { correlationId: 'c', server: 's', tool: 't' }, { structured: true });
    expect(result.data).toEqual({ structured: true });
  });

  it('auto-injects _meta into the template scope (spec-kit context.run_id analog)', () => {
    write('with-meta', '---\nid: wm\n---\ncid={{ _meta.correlationId }} srv={{ _meta.server }} tool={{ _meta.tool }}');
    const result = templateResponse(
      'with-meta',
      {},
      { correlationId: 'abc123', server: 'mcp-jira', tool: 'jira.get_issue' },
    );
    expect(result.data).toBe('cid=abc123 srv=mcp-jira tool=jira.get_issue');
  });

  it('user-supplied _meta in variables overrides auto-injection (escape hatch)', () => {
    write('override-meta', '---\nid: om\n---\ncid={{ _meta.correlationId }}');
    const result = templateResponse(
      'override-meta',
      { _meta: { correlationId: 'user-wins' } },
      { correlationId: 'auto-loses', server: 's', tool: 't' },
    );
    expect(result.data).toBe('cid=user-wins');
  });
});

describe('determinism', () => {
  it('produces identical output for identical input (LLM-agnostic guarantee)', () => {
    write('det', '---\nid: d\n---\n{{#each xs}}- {{ this }}\n{{/each}}');
    const a = renderTemplate('det', { xs: ['a', 'b', 'c'] });
    const b = renderTemplate('det', { xs: ['a', 'b', 'c'] });
    expect(a).toBe(b);
  });

  it('loadTemplate caches the parsed template', () => {
    write('cache', '---\nid: k\n---\nbody');
    const first = loadTemplate('cache');
    const second = loadTemplate('cache');
    expect(second).toBe(first);
  });
});
