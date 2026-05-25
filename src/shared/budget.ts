/**
 * Token-budget tracking for LLM-bound extraction pipelines.
 *
 * Why a heuristic and not a real tokeniser?
 *   - Real tokenisers (tiktoken, anthropic SDK counter) are model-specific, add a
 *     dependency, and slow per-call hot loops.
 *   - For "stop before context overflows" the right ballpark is enough.
 *   - Heuristic: 3.5 chars per token (Claude/Anthropic average for mixed
 *     English + JSON), padded with a 25 % safety margin.
 *
 * Override per-call by constructing a `BudgetTracker` with a custom estimator.
 */

/** Default chars-per-token ratio. Conservative for mixed JSON / English. */
const CHARS_PER_TOKEN = 3.5;

/** Safety margin applied to estimates to absorb tokeniser quirks. */
const SAFETY = 1.25;

/** Estimate the token count for a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY);
}

/** Estimate tokens for an arbitrary JSON-serialisable value. */
export function estimateValueTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return estimateTokens(value);
  if (typeof value === 'number' || typeof value === 'boolean') return estimateTokens(String(value));
  return estimateTokens(JSON.stringify(value));
}

/**
 * Truncate text to fit within `maxTokens`. Adds an obvious suffix marker so
 * the consumer can detect truncation downstream. The suffix counts toward the
 * budget — what comes back is guaranteed to fit.
 */
export function truncate(text: string, maxTokens: number, suffix = '\n…[truncated]'): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const suffixTokens = estimateTokens(suffix);
  const headroom = Math.max(1, maxTokens - suffixTokens);
  // chars budget = headroom tokens × chars/token / safety; floor for safety
  const chars = Math.max(1, Math.floor((headroom * CHARS_PER_TOKEN) / SAFETY));
  return `${text.slice(0, chars)}${suffix}`;
}

/**
 * Mutable token-budget tracker passed through the extraction pipeline.
 * Each `consume()` call subtracts the cost of the supplied text/value and
 * returns the remaining budget. Once exceeded, callers stop iterating.
 */
export class BudgetTracker {
  private readonly max: number;
  private used = 0;

  constructor(maxTokens: number) {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      throw new RangeError('BudgetTracker: maxTokens must be a positive finite number');
    }
    this.max = Math.floor(maxTokens);
  }

  /** Consume budget for an arbitrary value; returns remaining tokens (≥ 0). */
  consume(value: unknown): number {
    this.used += estimateValueTokens(value);
    return this.remaining();
  }

  /** Consume an explicit token count (used when the caller has its own estimator). */
  consumeTokens(tokens: number): number {
    if (!Number.isFinite(tokens) || tokens < 0) return this.remaining();
    this.used += Math.ceil(tokens);
    return this.remaining();
  }

  /** Remaining budget (clamped at 0). */
  remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  /** Cumulative consumed tokens (may exceed `max` after the last item lands). */
  consumed(): number {
    return this.used;
  }

  /** True once the budget has been used up. */
  exceeded(): boolean {
    return this.used >= this.max;
  }

  /** Reset the tracker for a fresh extraction. */
  reset(): void {
    this.used = 0;
  }

  /** Cap on this tracker. */
  capacity(): number {
    return this.max;
  }
}
