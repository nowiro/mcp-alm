import { describe, expect, it } from 'vitest';

import { buildMeta, estimatePayloadTokens, isToolResponse, wrapResponse } from './response-meta.js';

describe('estimatePayloadTokens', () => {
  it('returns 0 for nullish payloads', () => {
    expect(estimatePayloadTokens(undefined)).toBe(0);
    expect(estimatePayloadTokens(null)).toBe(0);
  });

  it('uses chars/4 for strings', () => {
    expect(estimatePayloadTokens('1234')).toBe(1);
    expect(estimatePayloadTokens('12345678')).toBe(2);
  });

  it('JSON-stringifies objects before measuring', () => {
    // {"a":1} -> 7 chars -> ceil(7/4) = 2
    expect(estimatePayloadTokens({ a: 1 })).toBe(2);
  });

  it('handles numbers and booleans via JSON length', () => {
    expect(estimatePayloadTokens(12_345)).toBe(2); // "12345" -> 5 chars -> 2
    expect(estimatePayloadTokens(true)).toBe(1); // "true" -> 4 chars -> 1
  });
});

describe('buildMeta', () => {
  it('attaches every required field', () => {
    const meta = buildMeta({ hello: 'world' }, { correlationId: 'cid-1', server: 'mcp-jira', tool: 'jira.get_issue' });
    expect(meta.correlationId).toBe('cid-1');
    expect(meta.server).toBe('mcp-jira');
    expect(meta.tool).toBe('jira.get_issue');
    expect(typeof meta.tokensEstimate).toBe('number');
    expect(meta.tokensEstimate).toBeGreaterThan(0);
    expect(meta.durationMs).toBeUndefined();
    expect(meta.truncated).toBeUndefined();
  });

  it('includes durationMs only when supplied', () => {
    const withMs = buildMeta('x', { correlationId: 'cid', server: 's', tool: 't', durationMs: 42 });
    expect(withMs.durationMs).toBe(42);
  });

  it('includes truncated only when supplied', () => {
    const flagged = buildMeta('x', { correlationId: 'cid', server: 's', tool: 't', truncated: true });
    expect(flagged.truncated).toBe(true);
  });

  it('emits keys in the documented order (tokens → correlationId → server → tool → durationMs → truncated)', () => {
    const meta = buildMeta('x', { correlationId: 'cid', server: 's', tool: 't', durationMs: 1, truncated: true });
    expect(Object.keys(meta)).toEqual(['tokensEstimate', 'correlationId', 'server', 'tool', 'durationMs', 'truncated']);
  });
});

describe('wrapResponse + isToolResponse', () => {
  it('round-trips data + _meta', () => {
    const meta = buildMeta({ a: 1 }, { correlationId: 'c', server: 's', tool: 't' });
    const wrapped = wrapResponse({ a: 1 }, meta);
    expect(wrapped.data).toEqual({ a: 1 });
    expect(wrapped._meta).toBe(meta);
    expect(isToolResponse(wrapped)).toBe(true);
  });

  it('rejects shapes missing _meta or data', () => {
    expect(isToolResponse({ data: 1 })).toBe(false);
    expect(isToolResponse({ _meta: {} })).toBe(false);
    expect(isToolResponse(null)).toBe(false);
    expect(isToolResponse('hello')).toBe(false);
  });
});
