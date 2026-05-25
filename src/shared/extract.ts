/**
 * Composition pipeline for budget-aware extraction.
 *
 * Glues together:
 *   - `pagination.ts` — fetches pages on demand
 *   - `budget.ts`     — tracks LLM-context spend
 *   - `field-registry.ts` (caller-applied) — custom field reshaping
 *   - `adf.ts`        (caller-applied) — body normalisation
 *
 * The pipeline accepts:
 *   - a `fetchPage` (Jira / Confluence / GitHub …)
 *   - a `reshape` callback that turns one raw item into the canonical form
 *     (this is where the caller pulls in field-registry / adf)
 *   - a `BudgetTracker`
 *
 * It walks pages, reshapes each item, charges the budget, and stops the
 * moment the budget is exhausted — returning a clear truncation reason and
 * a cursor the caller can use to continue.
 */
import type { BudgetTracker } from './budget.js';
import { iterate, type FetchPage, type NextCursor, type Page } from './pagination.js';

export interface ExtractOptions<TIn, TOut> {
  /** Pagination source (Jira offset, Confluence cursor, etc.). */
  readonly fetchPage: FetchPage<TIn>;
  /** Convert a raw item into the canonical caller-defined shape. */
  readonly reshape: (item: TIn) => TOut;
  /** Tracker used for the per-item charge. */
  readonly budget: BudgetTracker;
  /**
   * Optional — override the per-item token estimate. Default: budget tracker
   * estimates the full reshaped value (`estimateValueTokens` on JSON).
   */
  readonly estimate?: (item: TOut) => number;
  /** Optional — page cap (default 100). */
  readonly maxPages?: number;
  /** Optional — item cap (default 5 000). */
  readonly maxItems?: number;
  /** AC52: opcjonalna współbieżność (1-4); wymaga `nextCursor`. */
  readonly concurrency?: number;
  /** AC52: deterministic next-cursor computer; wymagany dla `concurrency > 1`. */
  readonly nextCursor?: NextCursor;
}

export interface ExtractResult<T> {
  readonly items: readonly T[];
  /** Total reported by the upstream (Jira does, Confluence v2 does not). */
  readonly total?: number;
  /** True when extraction stopped before exhausting the source. */
  readonly truncated: boolean;
  /** Why iteration stopped early. */
  readonly truncationReason?: 'budget' | 'page-limit' | 'item-limit';
  /** Cursor / offset to pass back to the API to resume; absent when fully drained. */
  readonly next?: string | number;
}

type TruncationReason = ExtractResult<unknown>['truncationReason'];

interface PageOutcome {
  readonly truncationReason?: TruncationReason;
  readonly next?: string | number;
}

/**
 * Walk pages → reshape → charge budget → stop on budget exhaustion or caps.
 */
export async function extract<TIn, TOut>(options: ExtractOptions<TIn, TOut>): Promise<ExtractResult<TOut>> {
  const items: TOut[] = [];
  let total: number | undefined;
  let next: string | number | undefined;
  let truncated = false;
  let truncationReason: TruncationReason;

  const maxItems = options.maxItems ?? 5000;
  const maxPages = options.maxPages ?? 100;

  const pages = iterate({
    fetchPage: options.fetchPage,
    budget: options.budget,
    maxPages,
    maxItems,
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
  });

  for await (const page of pages) {
    if (page.total !== undefined) total = page.total;

    const outcome = consumePage(page, items, options, maxItems);
    if (outcome.truncationReason) {
      truncated = true;
      truncationReason = outcome.truncationReason;
      next = outcome.next ?? next;
      break;
    }
    next = page.next;
    if (page.next === undefined) break;
  }

  return {
    items,
    total,
    truncated,
    ...(truncationReason ? { truncationReason } : {}),
    ...(next === undefined ? {} : { next }),
  };
}

/**
 * Consume one page worth of raw items: reshape, charge the budget, and append
 * to `items`. Returns a `PageOutcome` indicating whether the loop should stop.
 */
function consumePage<TIn, TOut>(
  page: Page<TIn>,
  items: TOut[],
  options: ExtractOptions<TIn, TOut>,
  maxItems: number,
): PageOutcome {
  for (const raw of page.items) {
    const reshaped = options.reshape(raw);

    if (!chargeItem(reshaped, options.budget, options.estimate)) {
      return { truncationReason: 'budget', next: page.next };
    }

    items.push(reshaped);

    if (items.length >= maxItems) {
      return { truncationReason: 'item-limit', next: page.next };
    }
    if (options.budget.exceeded()) {
      return { truncationReason: 'budget', next: page.next };
    }
  }
  return {};
}

/**
 * Charge the budget for one reshaped item. Returns `false` when the explicit
 * estimator says the item won't fit (strict semantics) — the item is then
 * NOT added. With no estimator we use the relaxed JSON-based fallback and
 * always return `true`; the outer loop catches the overrun via `exceeded()`.
 */
function chargeItem<TOut>(item: TOut, budget: BudgetTracker, estimate: ((item: TOut) => number) | undefined): boolean {
  if (estimate) {
    const cost = estimate(item);
    if (cost > budget.remaining()) return false;
    budget.consumeTokens(cost);
    return true;
  }
  budget.consume(item);
  return true;
}
