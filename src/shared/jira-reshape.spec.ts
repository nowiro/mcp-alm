import { describe, expect, it } from 'vitest';

import { reshapeJiraIssue } from './jira-reshape.js';
import type { FieldMeta, FieldRegistry } from './field-registry.js';

function fakeRegistry(map: Record<string, FieldMeta>): FieldRegistry {
  return {
    async load() {
      /* noop */
    },
    byId(id) {
      return map[id];
    },
    byName(name) {
      return Object.values(map).find((m) => m.name.toLowerCase() === name.toLowerCase());
    },
    list() {
      return Object.values(map);
    },
    ready() {
      return true;
    },
  };
}

describe('reshapeJiraIssue', () => {
  it('keeps the key + id', () => {
    const out = reshapeJiraIssue({ id: '1', key: 'ABC-1' }, fakeRegistry({}));
    expect(out.key).toBe('ABC-1');
    expect(out.id).toBe('1');
  });

  it('extracts summary, status, issueType, priority', () => {
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        fields: {
          summary: 'Fix the thing',
          status: { id: '10000', name: 'Done' },
          issuetype: { id: '1', name: 'Bug' },
          priority: { id: '3', name: 'Medium' },
        },
      },
      fakeRegistry({}),
    );
    expect(out.summary).toBe('Fix the thing');
    expect(out.status).toEqual({ id: '10000', name: 'Done' });
    expect(out.issueType).toEqual({ id: '1', name: 'Bug' });
    expect(out.priority).toEqual({ id: '3', name: 'Medium' });
  });

  it('renders ADF description to Markdown', () => {
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        fields: {
          description: {
            type: 'doc',
            content: [
              { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Goal' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Ship it.' }] },
            ],
          },
        },
      },
      fakeRegistry({}),
    );
    expect(out.descriptionMd).toContain('# Goal');
    expect(out.descriptionMd).toContain('Ship it.');
  });

  it('maps known customfield IDs to readable names', () => {
    const registry = fakeRegistry({
      customfield_10016: { id: 'customfield_10016', name: 'Story Points', custom: true, type: 'number' },
    });
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        fields: { customfield_10016: 5 },
      },
      registry,
    );
    expect(out.customFields).toHaveLength(1);
    expect(out.customFields?.[0]).toEqual({
      id: 'customfield_10016',
      name: 'Story Points',
      type: 'number',
      value: 5,
    });
  });

  it('still emits unknown custom fields with the raw id (no metadata available)', () => {
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        fields: { customfield_99999: 'something' },
      },
      fakeRegistry({}),
    );
    expect(out.customFields).toHaveLength(1);
    expect(out.customFields?.[0]?.type).toBe('unknown');
    expect(out.customFields?.[0]?.value).toBe('something');
  });

  it('drops null / empty array fields from customFields output', () => {
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        fields: { customfield_1: null, customfield_2: [], customfield_3: 'kept' },
      },
      fakeRegistry({}),
    );
    expect(out.customFields).toHaveLength(1);
  });

  it('caps very long description and sets descriptionTruncated', () => {
    const longText = 'x'.repeat(20_000);
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        fields: {
          description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }] },
        },
      },
      fakeRegistry({}),
    );
    expect(out.descriptionTruncated).toBe(true);
    expect((out.descriptionMd ?? '').length).toBeLessThan(longText.length);
    expect(out.descriptionMd).toContain('…[truncated]');
  });

  it('omits description field when ADF renders to empty', () => {
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        fields: { description: null },
      },
      fakeRegistry({}),
    );
    expect(out.descriptionMd).toBeUndefined();
  });

  it('extracts assignee + reporter as {accountId, displayName}', () => {
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        fields: {
          assignee: { accountId: 'aid1', displayName: 'Alice' },
          reporter: { accountId: 'aid2', displayName: 'Bob' },
        },
      },
      fakeRegistry({}),
    );
    expect(out.assignee).toEqual({ accountId: 'aid1', displayName: 'Alice' });
    expect(out.reporter).toEqual({ accountId: 'aid2', displayName: 'Bob' });
  });

  it('serialises keys in a deterministic order (key → id → identity → metadata → body → custom)', () => {
    const out = reshapeJiraIssue(
      {
        id: '1',
        key: 'ABC-1',
        self: 'https://acme.atlassian.net/rest/api/3/issue/1',
        fields: {
          summary: 'Fix the thing',
          status: { id: '10000', name: 'Done' },
          issuetype: { id: '1', name: 'Bug' },
          priority: { id: '3', name: 'Medium' },
          assignee: { accountId: 'aid1', displayName: 'Alice' },
          reporter: { accountId: 'aid2', displayName: 'Bob' },
          labels: ['p1'],
          created: '2026-05-15T10:00:00.000Z',
          updated: '2026-05-16T10:00:00.000Z',
          customfield_999: 'whatever',
        },
      },
      fakeRegistry({}),
    );
    expect(Object.keys(out)).toEqual([
      'key',
      'id',
      'url',
      'summary',
      'status',
      'issueType',
      'priority',
      'assignee',
      'reporter',
      'labels',
      'created',
      'updated',
      'customFields',
    ]);
  });
});
