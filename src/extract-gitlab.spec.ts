/**
 * Testy dla deterministycznych części `extract-gitlab.ts`:
 *   - schema configu (discriminated union: issues/mrs/pipelines)
 *   - renderers Markdown (pure functions)
 */
import { describe, expect, it } from 'vitest';

import {
  ExtractConfig,
  renderIssueMarkdown,
  renderMrMarkdown,
  renderPipelineMarkdown,
  type ExtractedIssue,
  type ExtractedMr,
  type ExtractedPipeline,
} from './extract-gitlab.js';

describe('ExtractConfig (GitLab)', () => {
  it('parses issues snapshot with defaults', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'open', type: 'issues', projectId: 'group/project' }],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'issues') throw new Error(`expected issues, got ${snap.type}`);
    expect(snap.state).toBe('all');
    expect(snap.maxItems).toBe(500);
    expect(snap.includeNotes).toBe(true);
    expect(snap.render).toEqual(['json', 'markdown']);
  });

  it('parses mrs snapshot with optional flags', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'merged', type: 'mrs', projectId: '12345', state: 'merged', includeChanges: true }],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'mrs') throw new Error('expected mrs');
    expect(snap.state).toBe('merged');
    expect(snap.includeChanges).toBe(true);
  });

  it('parses pipelines snapshot', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'recent', type: 'pipelines', projectId: '1', ref: 'main', maxItems: 50 }],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'pipelines') throw new Error('expected pipelines');
    expect(snap.ref).toBe('main');
    expect(snap.maxItems).toBe(50);
    expect(snap.includeJobs).toBe(true);
  });

  it('rejects unknown type', () => {
    expect(() =>
      ExtractConfig.parse({ snapshots: [{ name: 'x', type: 'commits' as 'issues', projectId: '1' }] }),
    ).toThrow();
  });

  it('rejects empty projectId', () => {
    expect(() => ExtractConfig.parse({ snapshots: [{ name: 'x', type: 'issues', projectId: '' }] })).toThrow();
  });

  it('rejects maxItems beyond cap', () => {
    expect(() =>
      ExtractConfig.parse({ snapshots: [{ name: 'x', type: 'pipelines', projectId: '1', maxItems: 5000 }] }),
    ).toThrow();
  });
});

describe('renderIssueMarkdown (GitLab)', () => {
  const minimal: ExtractedIssue = { iid: 42, title: 'Investigate flaky test', state: 'opened' };

  it('produces header with !iid and title', () => {
    expect(renderIssueMarkdown(minimal)).toMatch(/^# !42 — Investigate flaky test/);
  });

  it('renders labels and milestone when present', () => {
    const md = renderIssueMarkdown({
      ...minimal,
      labels: ['bug', 'P1'],
      milestone: 'sprint-23',
      author: 'jane.doe',
    });
    expect(md).toContain('**Labels**: bug, P1');
    expect(md).toContain('**Milestone**: sprint-23');
    expect(md).toContain('**Author**: jane.doe');
  });

  it('renders notes section', () => {
    const md = renderIssueMarkdown({
      ...minimal,
      notes: [
        { id: 1, author: 'alice', system: false, createdAt: '2026-05-01T10:00:00Z', body: 'looking into this' },
        { id: 2, author: 'bot', system: true, createdAt: '2026-05-02T10:00:00Z', body: 'assigned to alice' },
      ],
    });
    expect(md).toContain('## Notes');
    expect(md).toContain('alice — 2026-05-01T10:00:00Z');
    expect(md).toContain('bot [system] — 2026-05-02T10:00:00Z');
  });

  it('is deterministic', () => {
    const issue: ExtractedIssue = {
      ...minimal,
      description: 'body',
      labels: ['x'],
      notes: [{ id: 1, author: 'a', system: false, createdAt: 't', body: 'b' }],
    };
    expect(renderIssueMarkdown(issue)).toBe(renderIssueMarkdown(issue));
  });
});

describe('renderMrMarkdown', () => {
  const minimal: ExtractedMr = { iid: 7, title: 'Add caching', state: 'opened' };

  it('renders branches with arrow', () => {
    const md = renderMrMarkdown({ ...minimal, sourceBranch: 'feat/cache', targetBranch: 'main' });
    expect(md).toContain('**Branches**: `feat/cache` → `main`');
  });

  it('marks draft and conflicts', () => {
    const md = renderMrMarkdown({ ...minimal, draft: true, hasConflicts: true });
    expect(md).toContain('**Draft**: yes');
    expect(md).toContain('**Conflicts**: yes');
  });

  it('renders changed files with markers', () => {
    const md = renderMrMarkdown({
      ...minimal,
      changes: [
        { newPath: 'new.ts', newFile: true, renamedFile: false, deletedFile: false },
        { oldPath: 'gone.ts', newFile: false, renamedFile: false, deletedFile: true },
        { oldPath: 'old.ts', newPath: 'renamed.ts', newFile: false, renamedFile: true, deletedFile: false },
        { oldPath: 'mod.ts', newPath: 'mod.ts', newFile: false, renamedFile: false, deletedFile: false },
      ],
    });
    expect(md).toContain('`+` new.ts');
    expect(md).toContain('`-` gone.ts');
    expect(md).toContain('`R` renamed.ts');
    expect(md).toContain('`M` mod.ts');
  });
});

describe('renderPipelineMarkdown', () => {
  const minimal: ExtractedPipeline = { id: 9999, status: 'success', ref: 'main', sha: 'abc12345' };

  it('renders header and refs', () => {
    const md = renderPipelineMarkdown(minimal);
    expect(md).toMatch(/^# Pipeline #9999 — success/);
    expect(md).toContain('**Ref**: `main`');
    expect(md).toContain('**SHA**: `abc12345`');
  });

  it('renders job list with status and duration', () => {
    const md = renderPipelineMarkdown({
      ...minimal,
      jobs: [
        { id: 1, name: 'build', stage: 'build', status: 'success', durationSec: 42.5 },
        { id: 2, name: 'test', stage: 'test', status: 'failed', durationSec: 120 },
      ],
    });
    expect(md).toContain('## Jobs');
    expect(md).toContain('`success` **build** [build] (42.5s)');
    expect(md).toContain('`failed` **test** [test] (120.0s)');
  });

  it('omits jobs section when empty', () => {
    const md = renderPipelineMarkdown(minimal);
    expect(md).not.toContain('## Jobs');
  });
});
