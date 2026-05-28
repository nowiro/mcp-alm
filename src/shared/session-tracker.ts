/**
 * In-memory tool-call ledger — every `tools/call` lands here so the operator
 * (or the agent itself) can ask `*.get_usage_history` and see what the session
 * cost in tokens.
 *
 * Design notes:
 *   - Process-local singleton — one tracker per server instance. Reset on restart.
 *   - Hard cap (`MAX_RECORDS`) so a long-running server cannot leak. Oldest
 *     records drop first (FIFO). The summary still reflects whatever's in memory.
 *   - No persistence — YAGNI. If an agent needs cross-session history, it can
 *     call `get_usage_history` and store the JSON itself.
 *   - No timers / async — purely synchronous; safe to call from a hot loop.
 */

/** Hard cap on retained records — bounds memory at ~200 KB worst case. */
const MAX_RECORDS = 1000;

export interface ToolCallRecord {
  /** ISO 8601 UTC. */
  readonly timestamp: string;
  /** Server identifier — e.g. `mcp-jira`. */
  readonly server: string;
  /** Tool name — e.g. `jira.search_issues`. */
  readonly tool: string;
  readonly correlationId: string;
  /** `JSON.stringify(input).length`. */
  readonly inputChars: number;
  /** `JSON.stringify(output).length`. */
  readonly outputChars: number;
  /** Mirrors `_meta.tokensEstimate` on the response. */
  readonly tokensEstimate: number;
  readonly durationMs: number;
  readonly ok: boolean;
  /** Set on failure — captures the message only, never the stack. */
  readonly error?: string;
}

export interface AggregatedBucket {
  readonly calls: number;
  readonly tokens: number;
}

/** Per-process counters incremented by the HTTP client. */
export interface HttpCounters {
  /** Total upstream `fetch` calls that actually hit the wire. */
  readonly upstreamCalls: number;
  /** GETs/HEADs coalesced by in-flight dedup (saved upstream round-trips). */
  readonly dedupHits: number;
  /** Responses served from the ETag/304 cache without re-parsing. */
  readonly cacheHits: number;
  /** Number of times we got back an ETag and stored a fresh body. */
  readonly cacheStores: number;
  /** Retries due to 429. */
  readonly retries429: number;
  /** Retries due to 5xx. */
  readonly retries5xx: number;
  /** Retries due to NetworkError (DNS, TCP, abort, SSRF). */
  readonly retriesNetwork: number;
  /** Requests that hit MAX_ATTEMPTS without success. */
  readonly retriesExhausted: number;
}

export interface SessionSummary {
  /** Newest-first list of records (caller can `.reverse()` if they want oldest-first). */
  readonly calls: readonly ToolCallRecord[];
  readonly totalCalls: number;
  readonly totalOutputChars: number;
  readonly totalTokens: number;
  readonly byTool: Readonly<Record<string, AggregatedBucket>>;
  readonly byServer: Readonly<Record<string, AggregatedBucket>>;
  readonly http: HttpCounters;
  /** ISO 8601 of when this tracker was instantiated (process start). */
  readonly sessionStartedAt: string;
  /** True once the FIFO cap evicted at least one record. */
  readonly truncated: boolean;
}

/** Rate-limit snapshot — kept process-local keyed by correlationId. */
export interface RateLimitSnapshot {
  readonly remaining?: number;
  readonly limit?: number;
  readonly resetAt?: string;
}

/** Synchronous per-process ledger. */
export class SessionTracker {
  private records: ToolCallRecord[] = [];
  private readonly startedAt = new Date().toISOString();
  private droppedCount = 0;
  /** Last rate-limit snapshot seen per correlation id. Trimmed when the call records. */
  private readonly rateLimits = new Map<string, RateLimitSnapshot>();
  private readonly http: {
    upstreamCalls: number;
    dedupHits: number;
    cacheHits: number;
    cacheStores: number;
    retries429: number;
    retries5xx: number;
    retriesNetwork: number;
    retriesExhausted: number;
  } = {
    upstreamCalls: 0,
    dedupHits: 0,
    cacheHits: 0,
    cacheStores: 0,
    retries429: 0,
    retries5xx: 0,
    retriesNetwork: 0,
    retriesExhausted: 0,
  };

  /** Record one tool call. Caller supplies everything except the timestamp. */
  record(entry: Omit<ToolCallRecord, 'timestamp'>): void {
    this.records.push({ timestamp: new Date().toISOString(), ...entry });
    if (this.records.length > MAX_RECORDS) {
      // FIFO — keep the most-recent `MAX_RECORDS`.
      const dropped = this.records.length - MAX_RECORDS;
      this.records = this.records.slice(dropped);
      this.droppedCount += dropped;
    }
  }

  /** Increment one of the HTTP counters. Called by `http-client.ts`. */
  bumpHttp(counter: keyof HttpCounters): void {
    this.http[counter] += 1;
  }

  /** Remember the most recent rate-limit snapshot seen on a given correlation id. */
  recordRateLimit(correlationId: string, snapshot: RateLimitSnapshot): void {
    if (snapshot.remaining === undefined && snapshot.limit === undefined && snapshot.resetAt === undefined) return;
    this.rateLimits.set(correlationId, snapshot);
  }

  /** Consume the latest rate-limit snapshot for a correlation id (called by `mcp-server.ts`). */
  takeRateLimit(correlationId: string): RateLimitSnapshot | undefined {
    const snapshot = this.rateLimits.get(correlationId);
    if (snapshot) this.rateLimits.delete(correlationId);
    return snapshot;
  }

  /** Build a summary snapshot — newest-first, with by-tool / by-server roll-ups. */
  getSummary(): SessionSummary {
    // Spread first so `reverse` mutates a local copy, not the underlying ledger.
    const newestFirst = [...this.records].reverse();
    const byTool: Record<string, AggregatedBucket> = {};
    const byServer: Record<string, AggregatedBucket> = {};
    let totalOutputChars = 0;
    let totalTokens = 0;

    for (const r of this.records) {
      totalOutputChars += r.outputChars;
      totalTokens += r.tokensEstimate;
      bump(byTool, r.tool, r.tokensEstimate);
      bump(byServer, r.server, r.tokensEstimate);
    }

    return {
      calls: newestFirst,
      totalCalls: this.records.length,
      totalOutputChars,
      totalTokens,
      byTool,
      byServer,
      http: { ...this.http },
      sessionStartedAt: this.startedAt,
      truncated: this.droppedCount > 0,
    };
  }

  /** Drop everything in memory and reset the dropped-count. */
  reset(): void {
    this.records = [];
    this.droppedCount = 0;
    this.rateLimits.clear();
    for (const key of Object.keys(this.http) as (keyof HttpCounters)[]) {
      this.http[key] = 0;
    }
  }

  /** Test hook — current record count without going through `getSummary`. */
  size(): number {
    return this.records.length;
  }
}

function bump(into: Record<string, AggregatedBucket>, key: string, tokens: number): void {
  if (Object.hasOwn(into, key)) {
    const previous = into[key];
    into[key] = { calls: previous.calls + 1, tokens: previous.tokens + tokens };
    return;
  }
  into[key] = { calls: 1, tokens };
}

/**
 * Process-wide singleton. Imported by `mcp-server.ts` (to record) and by every
 * server (to expose through `*.get_usage_history`).
 */
export const sessionTracker = new SessionTracker();
