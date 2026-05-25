/**
 * Unit tests — LLM optimization toolkit.
 */
import { describe, expect, it, vi } from 'vitest';

import { LruCache, cacheKey, compactJson, summarizeArray, terse } from './llm-optimize.js';

describe('compactJson', () => {
  it('drops null / undefined / empty arrays / empty objects by default', () => {
    expect(
      compactJson({
        a: 1,
        b: null,
        c: undefined,
        d: [],
        e: {},
        f: { g: null, h: 2 },
      }),
    ).toEqual({ a: 1, f: { h: 2 } });
  });

  it('drops empty strings by default', () => {
    expect(compactJson({ a: 'hello', b: '' })).toEqual({ a: 'hello' });
  });

  it('keeps boolean false by default (signal-bearing)', () => {
    expect(compactJson({ flag: false, val: 0 })).toEqual({ flag: false, val: 0 });
  });

  it('drops boolean false when dropFalse is true', () => {
    expect(compactJson({ flag: false, on: true }, { dropFalse: true })).toEqual({ on: true });
  });

  it('keeps nulls when dropNulls is false', () => {
    expect(compactJson({ a: null, b: 1 }, { dropNulls: false })).toEqual({ a: null, b: 1 });
  });

  it('recurses into nested arrays', () => {
    expect(compactJson({ items: [1, null, 2, [], { a: undefined }] })).toEqual({ items: [1, 2] });
  });

  it('returns primitives unchanged', () => {
    expect(compactJson(42)).toBe(42);
    expect(compactJson('hello')).toBe('hello');
    expect(compactJson(true)).toBe(true);
  });

  it('handles deeply nested null pruning', () => {
    expect(
      compactJson({
        outer: { mid: { inner: null, kept: 1 } },
      }),
    ).toEqual({ outer: { mid: { kept: 1 } } });
  });

  it('returns undefined when everything is pruned (caller signals "nothing to send")', () => {
    expect(compactJson({ a: { b: null, c: undefined } })).toBeUndefined();
  });
});

describe('terse', () => {
  it('drops fields equal to declared defaults', () => {
    expect(terse({ status: 'open', verbose: false }, { verbose: false })).toEqual({ status: 'open' });
  });

  it('keeps fields without declared default', () => {
    expect(terse({ a: 1, b: 2 }, { a: 0 })).toEqual({ a: 1, b: 2 });
  });

  it('drops undefined unconditionally', () => {
    expect(terse({ a: 1, b: undefined }, {})).toEqual({ a: 1 });
  });
});

describe('summarizeArray', () => {
  it('returns kind=full for short arrays', () => {
    expect(summarizeArray([1, 2, 3], { head: 5, tail: 0 })).toEqual({
      kind: 'full',
      items: [1, 2, 3],
    });
  });

  it('returns head/tail/total for long arrays', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const out = summarizeArray(arr, { head: 3, tail: 2 });
    expect(out.kind).toBe('summary');
    if (out.kind !== 'summary') throw new Error('unreachable — checked above');
    expect(out.head).toEqual([0, 1, 2]);
    expect(out.tail).toEqual([98, 99]);
    expect(out.total).toBe(100);
    expect(out.omitted).toBe(95);
  });

  it('honours custom threshold', () => {
    const arr = [1, 2, 3];
    expect(summarizeArray(arr, { threshold: 3 }).kind).toBe('summary');
    expect(summarizeArray(arr, { threshold: 4 }).kind).toBe('full');
  });

  it('handles tail=0 (head-only summary)', () => {
    const out = summarizeArray([1, 2, 3, 4, 5, 6, 7, 8], { head: 3, tail: 0 });
    expect(out.kind).toBe('summary');
    if (out.kind !== 'summary') throw new Error('unreachable — checked above');
    expect(out.tail).toEqual([]);
    expect(out.head).toEqual([1, 2, 3]);
  });
});

describe('cacheKey', () => {
  it('is deterministic for identical inputs', () => {
    expect(cacheKey(['jira', 'search', 'PROJ-1'])).toBe(cacheKey(['jira', 'search', 'PROJ-1']));
  });

  it('changes when any part changes', () => {
    expect(cacheKey(['a', 'b'])).not.toBe(cacheKey(['a', 'c']));
  });

  it('handles mixed primitive types', () => {
    expect(cacheKey(['t', 1, true, null]).length).toBe(16);
  });
});

describe('LruCache', () => {
  it('throws on invalid capacity / TTL', () => {
    expect(() => new LruCache(0, 1000)).toThrow(RangeError);
    expect(() => new LruCache(10, 0)).toThrow(RangeError);
  });

  it('stores + retrieves values within TTL', () => {
    const c = new LruCache<number>(10, 60_000);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.has('a')).toBe(true);
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    try {
      const c = new LruCache<number>(10, 1000);
      c.set('a', 1);
      vi.advanceTimersByTime(2000);
      expect(c.get('a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts least-recently-used when at capacity', () => {
    const c = new LruCache<number>(2, 60_000);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // mark 'a' as MRU
    c.set('c', 3); // should evict 'b' (LRU)
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
  });

  it('clear() empties the cache', () => {
    const c = new LruCache<number>(5, 60_000);
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size()).toBe(0);
  });

  it('size() reports current entries', () => {
    const c = new LruCache<string>(5, 60_000);
    expect(c.size()).toBe(0);
    c.set('a', 'x');
    c.set('b', 'y');
    expect(c.size()).toBe(2);
  });
});
