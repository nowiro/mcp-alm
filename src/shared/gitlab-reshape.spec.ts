import { describe, expect, it } from 'vitest';

import { reshapeGitLabIssue, reshapeGitLabMr, reshapeGitLabPipeline } from './gitlab-reshape.js';

describe('reshapeGitLabMr', () => {
  it('extracts identity + state + branches', () => {
    const out = reshapeGitLabMr({
      iid: 42,
      title: 'Fix the thing',
      state: 'opened',
      author: { username: 'alice' },
      source_branch: 'feat/x',
      target_branch: 'main',
      web_url: 'https://gitlab.example.com/proj/-/merge_requests/42',
    });
    expect(out.iid).toBe(42);
    expect(out.author).toBe('alice');
    expect(out.sourceBranch).toBe('feat/x');
    expect(out.targetBranch).toBe('main');
    expect(out.url).toContain('merge_requests/42');
  });

  it('trims long descriptions', () => {
    const huge = 'x'.repeat(5000);
    const out = reshapeGitLabMr({ iid: 1, title: 't', state: 'opened', description: huge });
    expect(out.descriptionTruncated).toBe(true);
    expect((out.description ?? '').length).toBeLessThan(huge.length);
  });

  it('extracts labels, reviewers, assignees', () => {
    const out = reshapeGitLabMr({
      iid: 1,
      title: 't',
      state: 'opened',
      labels: ['bug', 'priority::high'],
      reviewers: [{ username: 'bob' }, { username: 'eve' }],
      assignees: [{ username: 'alice' }],
    });
    expect(out.labels).toEqual(['bug', 'priority::high']);
    expect(out.reviewers).toEqual(['bob', 'eve']);
    expect(out.assignees).toEqual(['alice']);
  });

  it('honours work_in_progress as draft alias', () => {
    const out = reshapeGitLabMr({ iid: 1, title: 't', state: 'opened', work_in_progress: true });
    expect(out.draft).toBe(true);
  });
});

describe('reshapeGitLabIssue', () => {
  it('extracts core fields', () => {
    const out = reshapeGitLabIssue({
      iid: 7,
      title: 'Bug X',
      state: 'opened',
      labels: ['bug'],
      author: { username: 'alice' },
      milestone: { title: 'v1.0' },
      weight: 3,
    });
    expect(out.iid).toBe(7);
    expect(out.milestone).toBe('v1.0');
    expect(out.weight).toBe(3);
  });
});

describe('reshapeGitLabPipeline', () => {
  it('extracts status + ref + sha', () => {
    const out = reshapeGitLabPipeline({
      id: 99,
      status: 'success',
      ref: 'main',
      sha: 'abc123',
      source: 'push',
    });
    expect(out.id).toBe(99);
    expect(out.status).toBe('success');
    expect(out.ref).toBe('main');
  });
});
