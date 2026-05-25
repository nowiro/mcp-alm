/**
 * Unit tests — CQL builder for label-based page search.
 */
import { describe, expect, it } from 'vitest';

import { buildLabelSearchCql, escapeCqlString } from './confluence-cql.js';

describe('escapeCqlString', () => {
  it('passes plain values through unchanged', () => {
    expect(escapeCqlString('plain-label')).toBe('plain-label');
  });

  it('escapes embedded double quotes', () => {
    expect(escapeCqlString('weird"label')).toBe(String.raw`weird\"label`);
  });

  it('escapes embedded backslashes before quote handling', () => {
    expect(escapeCqlString(String.raw`a\b`)).toBe(String.raw`a\\b`);
  });
});

describe('buildLabelSearchCql', () => {
  it('builds a single-label CQL with type filter', () => {
    expect(buildLabelSearchCql({ labels: ['bug'] })).toBe('label in ("bug") AND type = "page"');
  });

  it('joins multiple labels in OR semantics', () => {
    expect(buildLabelSearchCql({ labels: ['bug', 'infra', 'security'] })).toBe(
      'label in ("bug","infra","security") AND type = "page"',
    );
  });

  it('appends a space.key clause when space is provided', () => {
    expect(buildLabelSearchCql({ labels: ['bug'], space: 'ENG' })).toBe(
      'label in ("bug") AND space.key = "ENG" AND type = "page"',
    );
  });

  it('ignores an empty / whitespace-only space', () => {
    expect(buildLabelSearchCql({ labels: ['bug'], space: '   ' })).toBe('label in ("bug") AND type = "page"');
    expect(buildLabelSearchCql({ labels: ['bug'], space: '' })).toBe('label in ("bug") AND type = "page"');
  });

  it('escapes double quotes inside label and space values', () => {
    expect(buildLabelSearchCql({ labels: ['weird"label'], space: 'sp"ce' })).toBe(
      String.raw`label in ("weird\"label") AND space.key = "sp\"ce" AND type = "page"`,
    );
  });

  it('trims label whitespace and drops empty entries', () => {
    expect(buildLabelSearchCql({ labels: ['  bug  ', '', '   ', 'infra'] })).toBe(
      'label in ("bug","infra") AND type = "page"',
    );
  });

  it('throws when no usable label is supplied', () => {
    expect(() => buildLabelSearchCql({ labels: [] })).toThrow(/at least one/i);
    expect(() => buildLabelSearchCql({ labels: ['  ', ''] })).toThrow(/at least one/i);
  });
});
