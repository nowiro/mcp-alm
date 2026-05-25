/**
 * Unit tests — JQL filter compiler.
 */
import { describe, expect, it } from 'vitest';

import { compileJqlFilter, JqlFilterSchema, lintRawJql, MAX_DEPTH, quote, type JqlFilter } from './jql-builder.js';

describe('quote', () => {
  it('wraps a plain value in double quotes', () => {
    expect(quote('Done')).toBe('"Done"');
  });

  it('escapes embedded double quotes', () => {
    expect(quote('my"string')).toBe(String.raw`"my\"string"`);
  });

  it('escapes embedded backslashes', () => {
    expect(quote(String.raw`a\b`)).toBe(String.raw`"a\\b"`);
  });

  it('escapes backslash before escaping quotes (no double-escape)', () => {
    // input: a\"b  (backslash + literal quote)  →  "a\\\"b"
    expect(quote(String.raw`a\"b`)).toBe(String.raw`"a\\\"b"`);
  });
});

describe('compileJqlFilter — single-kind nodes', () => {
  it('compiles a project filter', () => {
    const r = compileJqlFilter({ kind: 'project', key: 'PROJ' });
    expect(r.jql).toBe('project = "PROJ"');
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('compiles a status filter', () => {
    const r = compileJqlFilter({ kind: 'status', status: 'In Progress' });
    expect(r.jql).toBe('status = "In Progress"');
    expect(r.valid).toBe(true);
  });

  it('compiles an assignee filter with a username', () => {
    const r = compileJqlFilter({ kind: 'assignee', user: 'alice' });
    expect(r.jql).toBe('assignee = "alice"');
    expect(r.valid).toBe(true);
  });

  it('preserves currentUser() function call verbatim (no quoting)', () => {
    const r = compileJqlFilter({ kind: 'assignee', user: 'currentUser()' });
    expect(r.jql).toBe('assignee = currentUser()');
    expect(r.valid).toBe(true);
  });

  it('compiles updated_since to relative-date syntax', () => {
    const r = compileJqlFilter({ kind: 'updated_since', days: 7 });
    expect(r.jql).toBe('updated >= -7d');
    expect(r.valid).toBe(true);
  });
});

describe('compileJqlFilter — composite filters', () => {
  it('compiles AND with two children, wrapped in parens', () => {
    const r = compileJqlFilter({
      kind: 'and',
      filters: [
        { kind: 'project', key: 'PROJ' },
        { kind: 'status', status: 'Done' },
      ],
    });
    expect(r.jql).toBe('(project = "PROJ" AND status = "Done")');
    expect(r.valid).toBe(true);
  });

  it('compiles OR with three children', () => {
    const r = compileJqlFilter({
      kind: 'or',
      filters: [
        { kind: 'status', status: 'Open' },
        { kind: 'status', status: 'In Progress' },
        { kind: 'status', status: 'Reopened' },
      ],
    });
    expect(r.jql).toBe('(status = "Open" OR status = "In Progress" OR status = "Reopened")');
  });

  it('compiles NOT around a single filter', () => {
    const r = compileJqlFilter({
      kind: 'not',
      filter: { kind: 'status', status: 'Done' },
    });
    expect(r.jql).toBe('NOT (status = "Done")');
  });

  it('nests AND inside OR with correct precedence parens', () => {
    const r = compileJqlFilter({
      kind: 'or',
      filters: [
        {
          kind: 'and',
          filters: [
            { kind: 'project', key: 'PROJ' },
            { kind: 'assignee', user: 'currentUser()' },
          ],
        },
        { kind: 'updated_since', days: 14 },
      ],
    });
    expect(r.jql).toBe('((project = "PROJ" AND assignee = currentUser()) OR updated >= -14d)');
    expect(r.valid).toBe(true);
  });

  it('unwraps a single-child AND/OR group (no redundant parens)', () => {
    const r = compileJqlFilter({
      kind: 'and',
      filters: [{ kind: 'project', key: 'PROJ' }],
    });
    expect(r.jql).toBe('project = "PROJ"');
  });
});

describe('compileJqlFilter — escaping inside compiled JQL', () => {
  it('escapes quotes embedded in project key', () => {
    const r = compileJqlFilter({ kind: 'project', key: 'odd"key' });
    expect(r.jql).toBe(String.raw`project = "odd\"key"`);
    expect(r.valid).toBe(true);
  });

  it('escapes backslashes in status name', () => {
    const r = compileJqlFilter({ kind: 'status', status: String.raw`a\b` });
    expect(r.jql).toBe(String.raw`status = "a\\b"`);
  });
});

describe('compileJqlFilter — raw escape hatch', () => {
  it('passes a valid raw JQL string through unchanged', () => {
    const r = compileJqlFilter({ kind: 'raw', jql: 'project = "PROJ" AND priority > 2' });
    expect(r.jql).toBe('project = "PROJ" AND priority > 2');
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('trims surrounding whitespace from raw JQL', () => {
    const r = compileJqlFilter({ kind: 'raw', jql: '  project = "X"  ' });
    expect(r.jql).toBe('project = "X"');
  });

  it('flags unbalanced double quotes in raw JQL', () => {
    const r = compileJqlFilter({ kind: 'raw', jql: 'project = "PROJ' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((error) => error.includes('unbalanced double quotes'))).toBe(true);
  });

  it('flags unbalanced parentheses in raw JQL', () => {
    const r = compileJqlFilter({ kind: 'raw', jql: '(project = "PROJ" AND status = "Done"' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((error) => error.includes('unbalanced parentheses'))).toBe(true);
  });

  it('ignores parens inside string literals when balancing', () => {
    const r = compileJqlFilter({ kind: 'raw', jql: 'summary ~ "open ( bracket"' });
    expect(r.valid).toBe(true);
  });

  it('uses raw alongside structured composites', () => {
    const r = compileJqlFilter({
      kind: 'and',
      filters: [
        { kind: 'project', key: 'PROJ' },
        { kind: 'raw', jql: 'cf[10001] in ("alpha", "beta")' },
      ],
    });
    expect(r.jql).toBe('(project = "PROJ" AND cf[10001] in ("alpha", "beta"))');
    expect(r.valid).toBe(true);
  });
});

describe('compileJqlFilter — recursion depth guard', () => {
  it(`flags nesting beyond MAX_DEPTH (${MAX_DEPTH})`, () => {
    // Build a NOT chain MAX_DEPTH + 2 deep.
    let f: JqlFilter = { kind: 'project', key: 'PROJ' };
    for (let i = 0; i < MAX_DEPTH + 2; i++) f = { kind: 'not', filter: f };
    const r = compileJqlFilter(f);
    expect(r.valid).toBe(false);
    expect(r.errors.some((error) => error.includes('max depth'))).toBe(true);
  });
});

describe('lintRawJql', () => {
  it('returns no errors for a balanced expression', () => {
    expect(lintRawJql('project = "PROJ" AND (status = "Done" OR status = "Resolved")')).toEqual([]);
  });

  it('flags an early-closing parenthesis', () => {
    const errs = lintRawJql(')oops(');
    expect(errs.some((error) => error.includes('unbalanced parentheses'))).toBe(true);
  });
});

describe('JqlFilterSchema (Zod runtime)', () => {
  it('accepts a nested AND/OR tree', () => {
    const input: JqlFilter = {
      kind: 'and',
      filters: [
        { kind: 'project', key: 'PROJ' },
        {
          kind: 'or',
          filters: [
            { kind: 'status', status: 'Open' },
            { kind: 'updated_since', days: 30 },
          ],
        },
      ],
    };
    expect(() => JqlFilterSchema.parse(input)).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => JqlFilterSchema.parse({ kind: 'bogus', key: 'X' })).toThrow();
  });

  it('rejects an empty AND/OR group at the schema layer', () => {
    expect(() => JqlFilterSchema.parse({ kind: 'and', filters: [] })).toThrow();
  });

  it('rejects negative day counts', () => {
    expect(() => JqlFilterSchema.parse({ kind: 'updated_since', days: -1 })).toThrow();
  });
});
