/**
 * Unit tests — token-budget tracker.
 */
import { describe, expect, it } from 'vitest';

import { BudgetTracker, estimateTokens, estimateValueTokens, truncate } from './budget.js';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('grows linearly with text length', () => {
    const small = estimateTokens('a'.repeat(35));
    const large = estimateTokens('a'.repeat(350));
    expect(large).toBeGreaterThan(small * 9); // ~10x with safety margin
  });

  it('safety margin keeps estimate ≥ chars/4', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(25);
  });
});

describe('estimateValueTokens', () => {
  it('returns 0 for null / undefined', () => {
    expect(estimateValueTokens(null)).toBe(0);
    expect(estimateValueTokens(undefined)).toBe(0);
  });

  it('serialises objects via JSON.stringify', () => {
    const a = estimateValueTokens({ foo: 'bar' });
    const b = estimateTokens('{"foo":"bar"}');
    expect(a).toBe(b);
  });

  it('handles primitives', () => {
    expect(estimateValueTokens(42)).toBeGreaterThan(0);
    expect(estimateValueTokens(true)).toBeGreaterThan(0);
  });
});

describe('truncate', () => {
  it('returns input unchanged when within budget', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });

  it('appends truncation suffix when over budget', () => {
    const truncated = truncate('a'.repeat(10_000), 50);
    expect(truncated.endsWith('[truncated]')).toBe(true);
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(50);
  });

  it('honours custom suffix', () => {
    const out = truncate('a'.repeat(1000), 30, '~MORE~');
    expect(out.endsWith('~MORE~')).toBe(true);
  });
});

describe('BudgetTracker', () => {
  it('throws on non-positive max', () => {
    expect(() => new BudgetTracker(0)).toThrow(RangeError);
    expect(() => new BudgetTracker(-1)).toThrow(RangeError);
    expect(() => new BudgetTracker(Number.NaN)).toThrow(RangeError);
  });

  it('consume() accumulates and shrinks remaining', () => {
    const t = new BudgetTracker(100);
    expect(t.remaining()).toBe(100);
    t.consume('a'.repeat(35));
    expect(t.remaining()).toBeLessThan(100);
  });

  it('consumeTokens() takes an explicit count', () => {
    const t = new BudgetTracker(50);
    t.consumeTokens(20);
    expect(t.consumed()).toBe(20);
    expect(t.remaining()).toBe(30);
  });

  it('consumeTokens() ignores invalid input gracefully', () => {
    const t = new BudgetTracker(100);
    t.consumeTokens(Number.NaN);
    t.consumeTokens(-5);
    expect(t.consumed()).toBe(0);
  });

  it('exceeded() flips at the boundary', () => {
    const t = new BudgetTracker(10);
    expect(t.exceeded()).toBe(false);
    t.consumeTokens(10);
    expect(t.exceeded()).toBe(true);
  });

  it('reset() returns the tracker to fresh state', () => {
    const t = new BudgetTracker(100);
    t.consumeTokens(50);
    t.reset();
    expect(t.remaining()).toBe(100);
    expect(t.consumed()).toBe(0);
  });

  it('capacity() reports the cap', () => {
    expect(new BudgetTracker(123).capacity()).toBe(123);
  });
});
