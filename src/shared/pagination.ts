/**
 * Async-iterator pagination helpers — work for both Jira-style offset
 * (`startAt` + `maxResults`) and Confluence v2 / GitHub-style cursor (`next`).
 *
 * The caller drives the loop with a `for await` and `break`s when it has
 * enough — there is no implicit "fetch everything" mode.
 */
import type { BudgetTracker } from './budget.js';

/** A single page of results. */
export interface Page<T> {
  readonly items: readonly T[];
  /** Cursor / offset to pass to the next call. Absent ⇒ caller hit the last page. */
  readonly next?: string | number;
  /** Total result count if the upstream reports it (Jira does, Confluence v2 does not). */
  readonly total?: number;
}

/** Universal cursor type: offset (`number`), token (`string`), or absent (`undefined`). */
export type PageCursor = string | number | undefined;

/** A function the caller supplies to fetch one page given the cursor / offset. */
export type FetchPage<T> = (cursor: PageCursor) => Promise<Page<T>>;

/** AC52: deterministic next-cursor computer; wymagany dla `concurrency > 1`. */
export type NextCursor = (current: PageCursor, pageIndex: number) => PageCursor;

export interface IterateOptions<T> {
  /** Required — fetches the next page given a cursor. */
  readonly fetchPage: FetchPage<T>;
  /** Optional — stops iteration when the budget is spent. */
  readonly budget?: BudgetTracker;
  /** Optional — hard ceiling on number of pages fetched (default: 100). */
  readonly maxPages?: number;
  /** Optional — hard ceiling on number of items yielded (default: 5000). */
  readonly maxItems?: number;
  /**
   * AC52: opcjonalna współbieżność dla offset-based pagination (gdy `nextCursor`
   * jest dostarczone — funkcja deterministyczna następnego cursora). 1 = sekwencyjnie
   * (default), 2-4 = prefetch N-1 stron do przodu. Nie dla cursor-based gdzie
   * next jest w response (`nextCursor` undefined → automatic fallback do sequential).
   */
  readonly concurrency?: number;
  /**
   * AC52: compute następny cursor offline (bez czytania response). Wymagane do
   * `concurrency > 1`. Przykład dla Jira offset: `(_, n) => n * pageSize`.
   * Returns `undefined` żeby zakończyć iterację po danej stronie.
   */
  readonly nextCursor?: NextCursor;
}

/**
 * Async iterator over paged results. Dispatcher: sequential (default) lub
 * parallel (gdy `concurrency > 1` + `nextCursor` dostarczone). Caller drives
 * the loop z `for await` i `break`'iem na page boundary (e.g. "first 50 issues
 * are enough"). Budget i item-count caps to guardrails przeciw runaway loops.
 * @yields {Page<T>} one page per upstream `fetchPage` call.
 * @example
 *   const tracker = new BudgetTracker(20_000);
 *   for await (const page of iterate({ fetchPage, budget: tracker })) {
 *     for (const issue of page.items) yield issue;
 *     if (tracker.exceeded()) break;
 *   }
 */
export async function* iterate<T>(options: IterateOptions<T>): AsyncGenerator<Page<T>, void, void> {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  if (concurrency > 1 && options.nextCursor) {
    yield* iterateParallel(options, concurrency);
    return;
  }
  yield* iterateSequential(options);
}

/**
 * Sequential (default) iteration — używa response.next cursor, jedna strona w locie.
 * @yields {Page<T>} one page per upstream `fetchPage` call.
 */
async function* iterateSequential<T>(options: IterateOptions<T>): AsyncGenerator<Page<T>, void, void> {
  const maxPages = options.maxPages ?? 100;
  const maxItems = options.maxItems ?? 5000;
  let cursor: string | number | undefined = undefined;
  let pageCount = 0;
  let itemCount = 0;

  while (pageCount < maxPages && itemCount < maxItems) {
    const page = await options.fetchPage(cursor);
    pageCount += 1;
    itemCount += page.items.length;

    yield page;

    if (options.budget?.exceeded()) return;
    if (page.next === undefined || page.items.length === 0) return;
    cursor = page.next;
  }
}

/**
 * AC52: Parallel pagination dla offset-based źródeł. Trzyma queue z N pre-fetch'owanymi
 * stronami, yield'uje w kolejności (FIFO). Wymagane: `nextCursor(current, pageIndex)`
 * funkcja deterministyczna (offset = pageIndex * pageSize). Cursor-based źródła
 * gdzie next pochodzi tylko z response — używaj sequential (concurrency=1).
 *
 * Przykład Jira offset:
 * ```ts
 * for await (const page of iterate({
 *   fetchPage: (off) => fetchJira({ startAt: typeof off === 'number' ? off : 0 }),
 *   nextCursor: (_, n) => n * 50,
 *   concurrency: 3,
 * })) { ... }
 * ```
 * @yields {Page<T>} one page per upstream `fetchPage` call.
 */
async function* iterateParallel<T>(
  options: IterateOptions<T>,
  concurrency: number,
): AsyncGenerator<Page<T>, void, void> {
  const nextCursor = options.nextCursor;
  if (!nextCursor) throw new Error('iterate: concurrency > 1 requires nextCursor()');

  const state = createParallelState<T>(options.maxPages ?? 100, options.maxItems ?? 5000);
  prefillQueue(state, options, nextCursor, concurrency);

  while (state.inFlight.length > 0) {
    const first = state.inFlight.shift();
    if (!first) break;
    const { page } = await first;
    state.yielded += 1;
    state.itemCount += page.items.length;
    yield page;

    if (shouldStop(state, page, options.budget)) return;
    maybeQueueNext(state, page, options, nextCursor);
  }
}

interface ParallelState<T> {
  readonly maxPages: number;
  readonly maxItems: number;
  nextPageIndex: number;
  itemCount: number;
  yielded: number;
  exhausted: boolean;
  readonly inFlight: Promise<{ pageIndex: number; page: Page<T> }>[];
}

function createParallelState<T>(maxPages: number, maxItems: number): ParallelState<T> {
  return { maxPages, maxItems, nextPageIndex: 0, itemCount: 0, yielded: 0, exhausted: false, inFlight: [] };
}

async function fetchTagged<T>(
  fetchPage: IterateOptions<T>['fetchPage'],
  pageIndex: number,
  cursor: PageCursor,
): Promise<{ pageIndex: number; page: Page<T> }> {
  const page = await fetchPage(cursor);
  return { pageIndex, page };
}

function prefillQueue<T>(
  state: ParallelState<T>,
  options: IterateOptions<T>,
  nextCursor: NextCursor,
  concurrency: number,
): void {
  const startWindow = Math.min(concurrency, state.maxPages);
  for (let i = 0; i < startWindow; i += 1) {
    const cursor = i === 0 ? undefined : nextCursor(undefined, i);
    if (cursor === undefined && i > 0) {
      state.exhausted = true;
      break;
    }
    const idx = state.nextPageIndex;
    state.inFlight.push(fetchTagged(options.fetchPage, idx, cursor));
    state.nextPageIndex += 1;
  }
}

function shouldStop<T>(state: ParallelState<T>, page: Page<T>, budget: BudgetTracker | undefined): boolean {
  if (budget?.exceeded()) return true;
  if (state.yielded >= state.maxPages || state.itemCount >= state.maxItems) return true;
  if (page.next === undefined || page.items.length === 0) state.exhausted = true;
  return false;
}

function maybeQueueNext<T>(
  state: ParallelState<T>,
  page: Page<T>,
  options: IterateOptions<T>,
  nextCursor: NextCursor,
): void {
  if (state.exhausted || state.nextPageIndex >= state.maxPages) return;
  const cursor = nextCursor(page.next, state.nextPageIndex);
  if (cursor === undefined) {
    state.exhausted = true;
    return;
  }
  const idx = state.nextPageIndex;
  state.inFlight.push(fetchTagged(options.fetchPage, idx, cursor));
  state.nextPageIndex += 1;
}

/** Flatten an async iterator of pages into a single array, respecting all caps. */
export async function collect<T>(options: IterateOptions<T>): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const page of iterate(options)) {
    out.push(...page.items);
  }
  return out;
}

// ── Adapters ────────────────────────────────────────────────────────────────

/**
 * Confluence v2 (and GitHub Link-header) cursor pagination: each response
 * carries an opaque `next` cursor token (often embedded in `_links.next` or
 * a `Link: <next>; rel="next"` HTTP header).
 */
export function cursorAdapter<T, Raw>(
  fetchOnce: (cursor: string | undefined) => Promise<Raw>,
  pickItems: (raw: Raw) => readonly T[],
  pickNext: (raw: Raw) => string | undefined,
): FetchPage<T> {
  return async (cursor) => {
    const raw = await fetchOnce(typeof cursor === 'string' ? cursor : undefined);
    return {
      items: pickItems(raw),
      next: pickNext(raw),
    };
  };
}

/**
 * Jira `/rest/api/3/search/jql` cursor pagination — the replacement for the
 * legacy offset endpoint that Atlassian removed on 2025-05-01. The response
 * shape is `{ issues, nextPageToken?, isLast? }` — no `total`. Callers who
 * need a count fall back to `/rest/api/3/search/approximate-count`.
 */
export function jiraJqlCursorAdapter<T, Raw extends { nextPageToken?: string; isLast?: boolean }>(
  fetchOnce: (params: { nextPageToken?: string; maxResults: number }) => Promise<Raw>,
  pickItems: (raw: Raw) => readonly T[],
  pageSize = 50,
): FetchPage<T> {
  return async (cursor) => {
    const nextPageToken = typeof cursor === 'string' ? cursor : undefined;
    const raw = await fetchOnce({ nextPageToken, maxResults: pageSize });
    const items = pickItems(raw);
    return {
      items,
      next: raw.isLast === true ? undefined : raw.nextPageToken,
    };
  };
}

/**
 * Jira Agile (`/rest/agile/1.0/`) offset pagination — `{ startAt, maxResults,
 * total, issues | values }`. Unlike `/search/jql` (cursor), the agile endpoints
 * still page by numeric offset. The adapter advances `startAt` by the number of
 * items actually returned and stops once `startAt + returned >= total`; when the
 * response omits `total` it stops on the first short page. An empty page always
 * terminates (the `items.length > 0` guard rules out an infinite loop).
 */
export function jiraOffsetAdapter<T, Raw>(
  fetchOnce: (params: { startAt: number; maxResults: number }) => Promise<Raw>,
  pickItems: (raw: Raw) => readonly T[],
  pickTotal: (raw: Raw) => number | undefined,
  pageSize = 50,
): FetchPage<T> {
  return async (cursor) => {
    const startAt = typeof cursor === 'number' ? cursor : 0;
    const raw = await fetchOnce({ startAt, maxResults: pageSize });
    const items = pickItems(raw);
    const consumed = startAt + items.length;
    const total = pickTotal(raw);
    const hasMore = total !== undefined ? consumed < total : items.length === pageSize;
    return { items, next: hasMore && items.length > 0 ? consumed : undefined };
  };
}
