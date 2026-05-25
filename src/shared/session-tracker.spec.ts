import { beforeEach, describe, expect, it } from 'vitest';

import { SessionTracker } from './session-tracker.js';

function makeEntry(
  over: Partial<Parameters<SessionTracker['record']>[0]> = {},
): Parameters<SessionTracker['record']>[0] {
  return {
    server: 'mcp-jira',
    tool: 'jira.get_issue',
    correlationId: 'cid-1',
    inputChars: 10,
    outputChars: 100,
    tokensEstimate: 25,
    durationMs: 12,
    ok: true,
    ...over,
  };
}

describe('SessionTracker', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  it('starts empty', () => {
    const s = tracker.getSummary();
    expect(s.totalCalls).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.calls).toEqual([]);
    expect(s.byTool).toEqual({});
    expect(s.byServer).toEqual({});
    expect(s.truncated).toBe(false);
  });

  it('records a single call and aggregates it', () => {
    tracker.record(makeEntry());
    const s = tracker.getSummary();
    expect(s.totalCalls).toBe(1);
    expect(s.totalTokens).toBe(25);
    expect(s.totalOutputChars).toBe(100);
    expect(s.byTool['jira.get_issue']).toEqual({ calls: 1, tokens: 25 });
    expect(s.byServer['mcp-jira']).toEqual({ calls: 1, tokens: 25 });
  });

  it('rolls up across tools and servers', () => {
    tracker.record(makeEntry({ tool: 'jira.get_issue', tokensEstimate: 10 }));
    tracker.record(makeEntry({ tool: 'jira.search_issues', tokensEstimate: 30 }));
    tracker.record(makeEntry({ tool: 'github.get_pr', server: 'mcp-github', tokensEstimate: 100 }));
    const s = tracker.getSummary();
    expect(s.totalCalls).toBe(3);
    expect(s.totalTokens).toBe(140);
    expect(s.byTool).toEqual({
      'jira.get_issue': { calls: 1, tokens: 10 },
      'jira.search_issues': { calls: 1, tokens: 30 },
      'github.get_pr': { calls: 1, tokens: 100 },
    });
    expect(s.byServer).toEqual({
      'mcp-jira': { calls: 2, tokens: 40 },
      'mcp-github': { calls: 1, tokens: 100 },
    });
  });

  it('returns records newest-first', () => {
    tracker.record(makeEntry({ correlationId: 'first' }));
    tracker.record(makeEntry({ correlationId: 'second' }));
    tracker.record(makeEntry({ correlationId: 'third' }));
    const s = tracker.getSummary();
    expect(s.calls.map((c) => c.correlationId)).toEqual(['third', 'second', 'first']);
  });

  it('flags truncated once the cap (1 000) is exceeded', () => {
    for (let i = 0; i < 1100; i += 1) {
      tracker.record(makeEntry({ correlationId: `cid-${i}` }));
    }
    const s = tracker.getSummary();
    expect(s.totalCalls).toBe(1000);
    expect(s.truncated).toBe(true);
    // Oldest 100 dropped — newest entry is cid-1099.
    expect(s.calls[0]?.correlationId).toBe('cid-1099');
  });

  it('reset clears records and dropped-flag', () => {
    for (let i = 0; i < 1050; i += 1) tracker.record(makeEntry({ correlationId: `cid-${i}` }));
    expect(tracker.getSummary().truncated).toBe(true);
    tracker.reset();
    const s = tracker.getSummary();
    expect(s.totalCalls).toBe(0);
    expect(s.truncated).toBe(false);
  });

  it('records failures without tokens but preserves the error message', () => {
    tracker.record(makeEntry({ ok: false, tokensEstimate: 0, outputChars: 0, error: 'upstream 500' }));
    const s = tracker.getSummary();
    expect(s.totalCalls).toBe(1);
    expect(s.totalTokens).toBe(0);
    expect(s.calls[0]?.ok).toBe(false);
    expect(s.calls[0]?.error).toBe('upstream 500');
  });

  it('size() reports the count without rebuilding the summary', () => {
    tracker.record(makeEntry());
    tracker.record(makeEntry());
    expect(tracker.size()).toBe(2);
  });

  it('bumps HTTP counters and reports them in the summary', () => {
    tracker.bumpHttp('upstreamCalls');
    tracker.bumpHttp('upstreamCalls');
    tracker.bumpHttp('dedupHits');
    tracker.bumpHttp('cacheHits');
    tracker.bumpHttp('retries429');
    const s = tracker.getSummary();
    expect(s.http.upstreamCalls).toBe(2);
    expect(s.http.dedupHits).toBe(1);
    expect(s.http.cacheHits).toBe(1);
    expect(s.http.cacheStores).toBe(0);
    expect(s.http.retries429).toBe(1);
    expect(s.http.retriesExhausted).toBe(0);
  });

  it('records and consumes rate-limit snapshots per correlationId', () => {
    tracker.recordRateLimit('cid-1', { remaining: 4500, limit: 5000 });
    tracker.recordRateLimit('cid-2', { remaining: 100 });
    expect(tracker.takeRateLimit('cid-1')).toEqual({ remaining: 4500, limit: 5000 });
    // Second take is gone (consumed).
    expect(tracker.takeRateLimit('cid-1')).toBeUndefined();
    expect(tracker.takeRateLimit('cid-2')).toEqual({ remaining: 100 });
  });

  it('reset() also clears HTTP counters and rate-limit snapshots', () => {
    tracker.bumpHttp('cacheHits');
    tracker.recordRateLimit('cid-x', { remaining: 1 });
    tracker.reset();
    const s = tracker.getSummary();
    expect(s.http.cacheHits).toBe(0);
    expect(tracker.takeRateLimit('cid-x')).toBeUndefined();
  });
});
