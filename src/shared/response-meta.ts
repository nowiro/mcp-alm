/**
 * Per-call response envelope: `{ data, _meta }`.
 *
 * Why: from 2026-06-01 GitHub Copilot bills usage in tokens, and every byte
 * a tool returns lands in the agent's context. `_meta.tokensEstimate` gives
 * the agent (and our session tracker) a cheap, dependency-free way to budget
 * before the next call — no tiktoken, no SDK round-trip.
 *
 * Estimator: `Math.ceil(JSON.stringify(value).length / 4)` — the rule-of-thumb
 * 4-chars-per-token ratio is within ±15 % for mixed JSON/English on Claude /
 * GPT-4-family tokenisers. That's good enough for a budget tripwire; nothing
 * here ever bills the user.
 *
 * The shape is deliberately fixed (`data` first, `_meta` second) so the cached
 * prefix on the Copilot side stays predictable across calls.
 */

/**
 * Upstream rate-limit info parsed from response headers (when present).
 * Mirrors the GitHub-style `x-ratelimit-*` triple; Jira / Atlassian set a
 * superset, Sonar / Figma don't always provide headers — fields are optional.
 */
export interface RateLimitInfo {
  /** Remaining requests in the current window. */
  readonly remaining?: number;
  /** Total quota for the current window. */
  readonly limit?: number;
  /** ISO 8601 timestamp when the window resets, if upstream reports it. */
  readonly resetAt?: string;
}

/** Meta payload attached to every tool result. */
export interface ResponseMeta {
  /** Cheap approximation: `Math.ceil(chars / 4)`. */
  readonly tokensEstimate: number;
  /** Same id that travelled on the inbound `_meta` (or freshly minted). */
  readonly correlationId: string;
  /** Server name (e.g. `mcp-jira`). */
  readonly server: string;
  /** Tool name (e.g. `jira.search_issues`). */
  readonly tool: string;
  /** Wall time spent in `handle()` — populated by `mcp-server.ts`. */
  readonly durationMs?: number;
  /** Mirrors upstream extraction truncation, if any. */
  readonly truncated?: boolean;
  /** Upstream rate-limit snapshot, if any header was present on the last response. */
  readonly rateLimit?: RateLimitInfo;
}

/** Public envelope every tool returns. */
export interface ToolResponse<T = unknown> {
  readonly data: T;
  readonly _meta: ResponseMeta;
}

/** Type guard for downstream callers / specs. */
export function isToolResponse(value: unknown): value is ToolResponse {
  if (typeof value !== 'object' || value === null) return false;
  const bag = value as Record<string, unknown>;
  return 'data' in bag && typeof bag['_meta'] === 'object' && bag['_meta'] !== null;
}

/**
 * Cheap, allocation-light token estimate. Returns 0 for nullish payloads
 * so empty responses don't pollute the histogram with `1`-token rows.
 */
export function estimatePayloadTokens(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  const chars = typeof payload === 'string' ? payload.length : JSON.stringify(payload).length;
  return Math.ceil(chars / 4);
}

interface BuildMetaInput {
  readonly correlationId: string;
  readonly server: string;
  readonly tool: string;
  readonly durationMs?: number;
  readonly truncated?: boolean;
  readonly rateLimit?: RateLimitInfo;
}

/**
 * Build the `_meta` for a given payload. The key order here is the order the
 * caller will see in the wire JSON — keep it stable.
 */
export function buildMeta(payload: unknown, input: BuildMetaInput): ResponseMeta {
  return {
    tokensEstimate: estimatePayloadTokens(payload),
    correlationId: input.correlationId,
    server: input.server,
    tool: input.tool,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
    ...(input.rateLimit ? { rateLimit: input.rateLimit } : {}),
  };
}

/** Convenience: wrap a payload in the canonical envelope. */
export function wrapResponse<T>(data: T, meta: ResponseMeta): ToolResponse<T> {
  return { data, _meta: meta };
}
