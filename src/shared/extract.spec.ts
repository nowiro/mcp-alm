/**
 * Unit tests — extract pipeline (composition).
 */
import { describe, expect, it } from 'vitest';

import { BudgetTracker } from './budget.js';
import { extract } from './extract.js';
import type { Page } from './pagination.js';

interface RawIssue {
  readonly key: string;
  readonly summary: string;
}

function makeFetcher(pages: ReadonlyArray<readonly RawIssue[]>) {
  return async (cursor: string | number | undefined): Promise<Page<RawIssue>> => {
    const idx = typeof cursor === 'number' ? cursor : 0;
    return Promise.resolve({
      items: pages[idx] ?? [],
      next: idx + 1 < pages.length ? idx + 1 : undefined,
      total: pages.flat().length,
    });
  };
}

describe('extract', () => {
  it('drains all pages when budget allows', async () => {
    const fetchPage = makeFetcher([
      [
        { key: 'A-1', summary: 'one' },
        { key: 'A-2', summary: 'two' },
      ],
      [{ key: 'A-3', summary: 'three' }],
    ]);
    const result = await extract({
      fetchPage,
      reshape: (raw: RawIssue) => ({ key: raw.key }),
      budget: new BudgetTracker(1000),
    });
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.next).toBeUndefined();
  });

  it('stops on budget exhaustion and returns next cursor', async () => {
    const fetchPage = makeFetcher([
      [
        { key: 'A-1', summary: 'a'.repeat(200) },
        { key: 'A-2', summary: 'a'.repeat(200) },
      ],
      [{ key: 'A-3', summary: 'a'.repeat(200) }],
    ]);
    const budget = new BudgetTracker(20); // very tight
    const result = await extract({
      fetchPage,
      reshape: (raw: RawIssue) => ({ key: raw.key, summary: raw.summary }),
      budget,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe('budget');
    expect(result.next).toBeDefined();
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('honours item-limit', async () => {
    const fetchPage = makeFetcher([
      [
        { key: 'A-1', summary: 's' },
        { key: 'A-2', summary: 's' },
        { key: 'A-3', summary: 's' },
      ],
    ]);
    const result = await extract({
      fetchPage,
      reshape: (raw: RawIssue) => ({ key: raw.key }),
      budget: new BudgetTracker(1000),
      maxItems: 2,
    });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe('item-limit');
  });

  it('uses caller-supplied estimator when provided', async () => {
    const fetchPage = makeFetcher([
      [
        { key: 'A-1', summary: 's' },
        { key: 'A-2', summary: 's' },
        { key: 'A-3', summary: 's' },
      ],
    ]);
    const budget = new BudgetTracker(50);
    const result = await extract({
      fetchPage,
      reshape: (raw: RawIssue) => ({ key: raw.key }),
      budget,
      estimate: () => 30, // each item costs 30 → only 1 fits before exhaustion
    });
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe('budget');
  });
});
