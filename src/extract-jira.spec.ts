/**
 * Testy dla deterministycznych części `extract-jira.ts`:
 *   - schema configu (ExtractConfig) — defaulty, walidacja
 *   - renderer Markdown (renderIssueMarkdown) — pure function, deterministyczny
 *   - fixture roundtrip dla `buildExtractedIssue` — strażnik determinizmu
 *     output shape'u (każda zmiana w reshape / extras assembly = diff w
 *     inline snapshot)
 *
 * NIE testuje warstwy HTTP / auth — to integration territory wymagająca
 * mocka full http-client (osobny test integracyjny gdy będzie potrzebny).
 */
import { describe, expect, it } from 'vitest';

import {
  buildExtractedIssue,
  ExtractConfig,
  renderIssueMarkdown,
  type ExtractedIssue,
  type RawIssue,
} from './extract-jira.js';
import type { FieldRegistry } from './shared/field-registry.js';

describe('ExtractConfig (Jira)', () => {
  it('parses minimal config — fills defaults', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'a', jql: 'project = X' }],
    });
    expect(parsed.outputDir).toBe('./output/jira');
    expect(parsed.snapshots[0].maxIssues).toBe(1000);
    expect(parsed.snapshots[0].render).toEqual(['json', 'markdown']);
    expect(parsed.snapshots[0].include).toEqual({
      changelog: true,
      comments: true,
      worklog: true,
      attachments: true,
      renderedFields: true,
    });
  });

  it('rejects snapshot name with uppercase / spaces', () => {
    expect(() => ExtractConfig.parse({ snapshots: [{ name: 'Active Bugs', jql: 'x' }] })).toThrow();
    expect(() => ExtractConfig.parse({ snapshots: [{ name: 'ActiveBugs', jql: 'x' }] })).toThrow();
  });

  it('rejects empty jql', () => {
    expect(() => ExtractConfig.parse({ snapshots: [{ name: 'a', jql: '' }] })).toThrow();
  });

  it('rejects empty render array', () => {
    expect(() => ExtractConfig.parse({ snapshots: [{ name: 'a', jql: 'x', render: [] }] })).toThrow();
  });

  it('rejects maxIssues out of bounds', () => {
    expect(() => ExtractConfig.parse({ snapshots: [{ name: 'a', jql: 'x', maxIssues: 0 }] })).toThrow();
    expect(() => ExtractConfig.parse({ snapshots: [{ name: 'a', jql: 'x', maxIssues: 20_000 }] })).toThrow();
  });

  it('accepts partial include — fills missing flags with true', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'a', jql: 'x', include: { comments: false } }],
    });
    expect(parsed.snapshots[0].include).toEqual({
      changelog: true,
      comments: false,
      worklog: true,
      attachments: true,
      renderedFields: true,
    });
  });
});

describe('renderIssueMarkdown', () => {
  const minimalIssue: ExtractedIssue = {
    key: 'ABC-123',
    id: '10001',
    summary: 'Investigate login flakiness',
    status: { id: '3', name: 'In Progress' },
    issueType: { id: '1', name: 'Bug' },
    priority: { id: '2', name: 'High' },
    assignee: { accountId: 'a-1', displayName: 'Jane Doe' },
    reporter: { accountId: 'a-2', displayName: 'John Smith' },
    created: '2026-05-01T10:00:00Z',
    updated: '2026-05-22T14:00:00Z',
    labels: ['auth', 'flaky'],
  };

  it('produces a header with key and summary', () => {
    const md = renderIssueMarkdown(minimalIssue);
    expect(md).toMatch(/^# ABC-123 — Investigate login flakiness/);
  });

  it('renders all primary fields', () => {
    const md = renderIssueMarkdown(minimalIssue);
    expect(md).toContain('**Status**: In Progress');
    expect(md).toContain('**Type**: Bug');
    expect(md).toContain('**Priority**: High');
    expect(md).toContain('**Assignee**: Jane Doe');
    expect(md).toContain('**Reporter**: John Smith');
    expect(md).toContain('**Created**: 2026-05-01T10:00:00Z');
    expect(md).toContain('**Updated**: 2026-05-22T14:00:00Z');
    expect(md).toContain('**Labels**: auth, flaky');
  });

  it('shows em-dash for missing fields rather than "undefined"', () => {
    const sparseIssue: ExtractedIssue = { key: 'X-1', id: '1' };
    const md = renderIssueMarkdown(sparseIssue);
    expect(md).toContain('**Status**: —');
    expect(md).not.toContain('undefined');
  });

  it('prefers descriptionMdFull over descriptionMd when both present', () => {
    const issue: ExtractedIssue = {
      ...minimalIssue,
      descriptionMd: 'short version',
      descriptionMdFull: 'full long description with all details',
    };
    const md = renderIssueMarkdown(issue);
    expect(md).toContain('full long description with all details');
    expect(md).not.toContain('short version');
  });

  it('renders comments section when comments present', () => {
    const issue: ExtractedIssue = {
      ...minimalIssue,
      comments: [
        { id: 'c1', author: 'Alice', created: '2026-05-10T09:00:00Z', bodyMd: 'Looking into this' },
        { id: 'c2', author: 'Bob', created: '2026-05-11T11:00:00Z', bodyMd: 'Confirmed reproduction' },
      ],
    };
    const md = renderIssueMarkdown(issue);
    expect(md).toContain('## Comments');
    expect(md).toContain('Alice — 2026-05-10T09:00:00Z');
    expect(md).toContain('Looking into this');
    expect(md).toContain('Bob — 2026-05-11T11:00:00Z');
  });

  it('renders changelog section with field-level changes', () => {
    const issue: ExtractedIssue = {
      ...minimalIssue,
      changelog: [
        {
          id: 'h1',
          created: '2026-05-15T08:00:00Z',
          author: 'Jane Doe',
          changes: [{ field: 'status', from: 'To Do', to: 'In Progress' }],
        },
      ],
    };
    const md = renderIssueMarkdown(issue);
    expect(md).toContain('## Changelog');
    expect(md).toContain('**status**: `To Do` → `In Progress`');
  });

  it('skips sections when their data is absent', () => {
    const md = renderIssueMarkdown(minimalIssue);
    expect(md).not.toContain('## Comments');
    expect(md).not.toContain('## Worklog');
    expect(md).not.toContain('## Changelog');
    expect(md).not.toContain('## Attachments');
    expect(md).not.toContain('## Custom fields');
  });

  it('is deterministic — identical input produces identical output', () => {
    const issue: ExtractedIssue = {
      ...minimalIssue,
      comments: [{ id: 'c1', author: 'Alice', created: '2026-05-10T09:00:00Z', bodyMd: 'body' }],
      changelog: [
        {
          id: 'h1',
          created: '2026-05-15T08:00:00Z',
          author: 'Jane',
          changes: [{ field: 'status', from: 'a', to: 'b' }],
        },
      ],
    };
    const first = renderIssueMarkdown(issue);
    const second = renderIssueMarkdown(issue);
    expect(first).toBe(second);
  });
});

// ── Fixture roundtrip — strażnik output shape'u ───────────────────────────

/** Mock registry — zwraca undefined dla każdego ID, więc custom fields
 *  używają ID jako nazwy (deterministyczne bez sięgania po upstream). */
const mockRegistry: FieldRegistry = {
  load: () => Promise.resolve(),
  byId: () => undefined,
  byName: () => undefined,
  list: () => [],
  ready: () => true,
};

const minimalSnapshot = ExtractConfig.parse({
  snapshots: [{ name: 'fixture', jql: 'project = X' }],
}).snapshots[0];

describe('buildExtractedIssue — fixture roundtrip', () => {
  it('transforms minimal raw issue → canonical shape (snapshot)', () => {
    const raw: RawIssue = {
      id: '10001',
      key: 'ABC-123',
      self: 'https://example.atlassian.net/rest/api/3/issue/10001',
      fields: {
        summary: 'Sample issue',
        status: { id: '3', name: 'In Progress' },
        issuetype: { id: '1', name: 'Bug' },
        priority: { id: '2', name: 'High' },
        assignee: { accountId: 'a-1', displayName: 'Jane Doe' },
        reporter: { accountId: 'a-2', displayName: 'John Smith' },
        labels: ['frontend', 'flaky'],
        created: '2026-05-01T10:00:00.000Z',
        updated: '2026-05-22T14:00:00.000Z',
      },
    };

    const result = buildExtractedIssue(raw, mockRegistry, minimalSnapshot);

    expect(result).toMatchInlineSnapshot(`
      {
        "assignee": {
          "accountId": "a-1",
          "displayName": "Jane Doe",
        },
        "attachments": [],
        "changelog": [],
        "created": "2026-05-01T10:00:00.000Z",
        "id": "10001",
        "issueType": {
          "id": "1",
          "name": "Bug",
        },
        "key": "ABC-123",
        "labels": [
          "frontend",
          "flaky",
        ],
        "priority": {
          "id": "2",
          "name": "High",
        },
        "reporter": {
          "accountId": "a-2",
          "displayName": "John Smith",
        },
        "status": {
          "id": "3",
          "name": "In Progress",
        },
        "summary": "Sample issue",
        "updated": "2026-05-22T14:00:00.000Z",
        "url": "https://example.atlassian.net/rest/api/3/issue/10001",
      }
    `);
  });

  it('transforms raw issue with ADF description → Markdown body', () => {
    const adfDescription = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Repro' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Steps to reproduce ' },
            { type: 'text', text: 'the bug', marks: [{ type: 'strong' }] },
          ],
        },
      ],
    };

    const raw: RawIssue = {
      id: '10002',
      key: 'ABC-456',
      fields: {
        summary: 'With description',
        description: adfDescription,
      },
    };

    const result = buildExtractedIssue(raw, mockRegistry, minimalSnapshot);

    // Description przeszło przez adfToMarkdown — kanoniczny MD
    expect(result.descriptionMd).toBeDefined();
    expect(result.descriptionMd).toContain('Repro');
    expect(result.descriptionMd).toContain('Steps to reproduce');
    // Bold marker
    expect(result.descriptionMd).toContain('**the bug**');
  });

  it('transforms raw issue with changelog → normalized entries', () => {
    const raw: RawIssue = {
      id: '10003',
      key: 'ABC-789',
      fields: { summary: 'With changelog' },
      changelog: {
        histories: [
          {
            id: 'h1',
            created: '2026-05-10T09:00:00.000Z',
            author: { accountId: 'a-1', displayName: 'Jane' },
            items: [
              { field: 'status', fromString: 'To Do', toString: 'In Progress' },
              { field: 'assignee', fromString: undefined, toString: 'Jane' },
            ],
          },
        ],
      },
    };

    const result = buildExtractedIssue(raw, mockRegistry, minimalSnapshot);

    expect(result.changelog).toMatchInlineSnapshot(`
      [
        {
          "author": "Jane",
          "changes": [
            {
              "field": "status",
              "from": "To Do",
              "to": "In Progress",
            },
            {
              "field": "assignee",
              "from": undefined,
              "to": "Jane",
            },
          ],
          "created": "2026-05-10T09:00:00.000Z",
          "id": "h1",
        },
      ]
    `);
  });

  it('transforms raw issue with attachments → normalized list', () => {
    const raw: RawIssue = {
      id: '10004',
      key: 'ABC-101',
      fields: {
        summary: 'With attachments',
        attachment: [
          {
            id: 'att-1',
            filename: 'screenshot.png',
            mimeType: 'image/png',
            size: 12_345,
            created: '2026-05-15T11:00:00.000Z',
            author: { accountId: 'a-1', displayName: 'Bob' },
            content: 'https://example.atlassian.net/secure/attachment/att-1/screenshot.png',
          },
        ],
      },
    };

    const result = buildExtractedIssue(raw, mockRegistry, minimalSnapshot);

    expect(result.attachments).toMatchInlineSnapshot(`
      [
        {
          "author": "Bob",
          "contentUrl": "https://example.atlassian.net/secure/attachment/att-1/screenshot.png",
          "created": "2026-05-15T11:00:00.000Z",
          "filename": "screenshot.png",
          "id": "att-1",
          "mimeType": "image/png",
          "size": 12345,
        },
      ]
    `);
  });

  it('respects snapshot.include flags — disabled extras are absent from output', () => {
    const snapshotMinimal = ExtractConfig.parse({
      snapshots: [
        {
          name: 'minimal',
          jql: 'x',
          include: { changelog: false, comments: false, worklog: false, attachments: false, renderedFields: false },
        },
      ],
    }).snapshots[0];

    const raw: RawIssue = {
      id: '1',
      key: 'X-1',
      fields: { summary: 's', attachment: [{ id: 'a' }] },
      changelog: { histories: [{ id: 'h1', items: [] }] },
    };

    const result = buildExtractedIssue(raw, mockRegistry, snapshotMinimal);

    expect(result.changelog).toBeUndefined();
    expect(result.attachments).toBeUndefined();
  });

  it('two calls with same raw + same snapshot produce deep-equal output', () => {
    const raw: RawIssue = {
      id: '10001',
      key: 'ABC-123',
      fields: {
        summary: 's',
        status: { id: '1', name: 'Open' },
        labels: ['a', 'b'],
      },
    };
    const first = buildExtractedIssue(raw, mockRegistry, minimalSnapshot);
    const second = buildExtractedIssue(raw, mockRegistry, minimalSnapshot);
    expect(first).toEqual(second);
    // I co ważniejsze — JSON-serialized bit-for-bit identical (key order matters)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
