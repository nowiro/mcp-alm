/**
 * Unit tests — pagination iterators.
 */
import { describe, expect, it } from 'vitest';

import { BudgetTracker } from './budget.js';
import { collect, cursorAdapter, iterate, jiraJqlCursorAdapter, type Page } from './pagination.js';

function makePages<T>(pages: ReadonlyArray<readonly T[]>): (cursor: string | number | undefined) => Promise<Page<T>> {
  return async (cursor) => {
    const idx = typeof cursor === 'number' ? cursor : 0;
    const items = pages[idx] ?? [];
    return Promise.resolve({
      items,
      next: idx + 1 < pages.length ? idx + 1 : undefined,
    });
  };
}

describe('iterate', () => {
  it('yields each page until next is undefined', async () => {
    const fetchPage = makePages([[1, 2], [3, 4], [5]]);
    const seen: number[][] = [];
    for await (const page of iterate({ fetchPage })) {
      seen.push([...page.items]);
    }
    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('stops when budget is exceeded', async () => {
    const fetchPage = makePages([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    const tracker = new BudgetTracker(10);
    let pages = 0;
    for await (const _page of iterate({ fetchPage, budget: tracker })) {
      pages += 1;
      tracker.consumeTokens(20); // overspend after the first page
    }
    expect(pages).toBe(1);
  });

  it('honours maxPages cap', async () => {
    const fetchPage = makePages([[1], [2], [3], [4], [5]]);
    let pages = 0;
    for await (const _ of iterate({ fetchPage, maxPages: 2 })) {
      pages += 1;
    }
    expect(pages).toBe(2);
  });

  it('honours maxItems cap', async () => {
    const fetchPage = makePages([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    let pages = 0;
    for await (const _ of iterate({ fetchPage, maxItems: 3 })) {
      pages += 1;
    }
    // After page 1 (2 items) we're at 2; after page 2 (4 items total) we exceed 3 → stop.
    expect(pages).toBe(2);
  });

  it('stops on empty page (defensive)', async () => {
    const fetchPage = async (): Promise<Page<number>> => Promise.resolve({ items: [], next: 99 });
    let pages = 0;
    for await (const _ of iterate({ fetchPage, maxPages: 5 })) {
      pages += 1;
    }
    expect(pages).toBe(1);
  });
});

describe('collect', () => {
  it('flattens all pages', async () => {
    const fetchPage = makePages([
      [1, 2],
      [3, 4],
    ]);
    const all = await collect({ fetchPage });
    expect(all).toEqual([1, 2, 3, 4]);
  });
});

describe('jiraJqlCursorAdapter', () => {
  it('walks nextPageToken until isLast is true', async () => {
    interface Page {
      issues: number[];
      nextPageToken?: string;
      isLast?: boolean;
    }
    const data: Record<string, Page> = {
      '': { issues: [1, 2], nextPageToken: 'tok2' },
      tok2: { issues: [3, 4], nextPageToken: 'tok3' },
      tok3: { issues: [5], isLast: true },
    };
    let calls = 0;
    const fetchOnce = async (params: { nextPageToken?: string; maxResults: number }): Promise<Page> => {
      calls += 1;
      return Promise.resolve(data[params.nextPageToken ?? ''] ?? { issues: [], isLast: true });
    };
    const adapter = jiraJqlCursorAdapter(fetchOnce, (raw) => raw.issues, 2);
    const all: number[] = [];
    for await (const page of iterate({ fetchPage: adapter })) {
      all.push(...page.items);
    }
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toBe(3);
  });

  it('stops when isLast is true even with nextPageToken present', async () => {
    const fetchOnce = async (): Promise<{ issues: number[]; nextPageToken?: string; isLast: boolean }> =>
      Promise.resolve({ issues: [1, 2], nextPageToken: 'stale-token', isLast: true });
    const adapter = jiraJqlCursorAdapter(fetchOnce, (raw) => raw.issues);
    const all: number[] = [];
    for await (const page of iterate({ fetchPage: adapter, maxPages: 5 })) {
      all.push(...page.items);
    }
    expect(all).toEqual([1, 2]);
  });
});

describe('cursorAdapter', () => {
  it('walks until pickNext returns undefined', async () => {
    const data: Array<{ items: number[]; next?: string }> = [
      { items: [1, 2], next: 'p2' },
      { items: [3, 4], next: 'p3' },
      { items: [5] },
    ];
    let calls = 0;
    const cursorIndex = (cursor: string | undefined): number => {
      if (cursor === 'p2') return 1;
      if (cursor === 'p3') return 2;
      return 0;
    };
    const fetchOnce = async (cursor: string | undefined): Promise<{ items: number[]; next?: string }> => {
      const idx = cursorIndex(cursor);
      calls += 1;
      return Promise.resolve(data[idx] ?? { items: [] });
    };
    const adapter = cursorAdapter(
      fetchOnce,
      (raw) => raw.items,
      (raw) => raw.next,
    );
    const all: number[] = [];
    for await (const page of iterate({ fetchPage: adapter })) {
      all.push(...page.items);
    }
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toBe(3);
  });
});

describe('iterate — parallel (concurrency > 1 + nextCursor)', () => {
  it('collects all items in order with concurrency=3', async () => {
    const fetchPage = makePages([[1, 2], [3, 4], [5, 6], [7]]);
    const all = await collect({ fetchPage, concurrency: 3, nextCursor: (_c, n) => n });
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('stops when nextCursor returns undefined', async () => {
    const fetchPage = makePages([[1], [2], [3], [4], [5]]);
    const all = await collect({ fetchPage, concurrency: 2, nextCursor: (_c, n) => (n < 2 ? n : undefined) });
    expect(all).toEqual([1, 2]);
  });

  it('honours maxItems cap in parallel mode', async () => {
    const fetchPage = makePages([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const all = await collect({ fetchPage, concurrency: 3, nextCursor: (_c, n) => n, maxItems: 3 });
    expect(all).toEqual([1, 2, 3, 4]); // stops after the page that crosses maxItems
  });

  it('stops on budget exceeded in parallel mode', async () => {
    const fetchPage = makePages([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const tracker = new BudgetTracker(10);
    const all: number[] = [];
    for await (const page of iterate({ fetchPage, concurrency: 3, nextCursor: (_c, n) => n, budget: tracker })) {
      all.push(...page.items);
      tracker.consumeTokens(20);
    }
    expect(all).toEqual([1, 2]);
  });

  it('falls back to sequential when concurrency > 1 but nextCursor is absent', async () => {
    const fetchPage = makePages([[1], [2]]);
    const all = await collect({ fetchPage, concurrency: 4 });
    expect(all).toEqual([1, 2]);
  });
});
