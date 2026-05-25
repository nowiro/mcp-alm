/**
 * Three-tier write guard.
 *
 * Tier 1 — mutating (POST / PATCH / PUT): default deny.
 *   1. Set `MCP_WRITE_ENABLED=true` in the server env.
 *   2. List exact tool names in `MCP_WRITE_ALLOWLIST=jira.create_issue,…`.
 *      An empty / missing allowlist is treated as deny-all — we never open
 *      every write tool just because the master flag is on.
 *   3. Each write tool MUST call `assertWriteAllowed(toolName)` before the
 *      mutation lands.
 *
 * Tier 2 — destructive (DELETE / drop / remove): tighter, opt-in on top of Tier 1.
 *   1. Tier 1 must be enabled (write is on AND the tool is on the write allowlist).
 *   2. The tool name MUST also appear in `MCP_DESTRUCTIVE_ALLOWLIST=jira.delete_issue,…`.
 *   3. The caller MUST pass `confirmToken` matching `MCP_DESTRUCTIVE_CONFIRM`.
 *      Comparison is constant-time (`crypto.timingSafeEqual`) so a guessing
 *      loop cannot recover the secret byte-by-byte.
 *
 * Tier 3 — resource-name confirmation: prevents wrong-resource deletes.
 *   1. Tier 2 must already have passed (env + confirmToken).
 *   2. The handler GETs the target resource and reads its current human-readable
 *      name (page title, repo path, issue summary).
 *   3. The caller MUST also pass `confirmResourceName` exactly matching that name.
 *      Protects against agent confusion / stale-context deletes where the secret
 *      token is correct but the resource id was guessed or out of date.
 *
 * The defaults are deny-deny-deny: no env vars = nothing destructive ever runs.
 */
import { timingSafeEqual } from 'node:crypto';

import { ConfirmationError, WriteDeniedError } from './errors.js';

/** Minimum length of `MCP_DESTRUCTIVE_CONFIRM` before we even consider it valid. */
const MIN_CONFIRM_LENGTH = 16;

export function isWriteEnabled(): boolean {
  return process.env['MCP_WRITE_ENABLED']?.toLowerCase() === 'true';
}

function parseList(name: string): ReadonlySet<string> {
  const raw = process.env[name] ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function assertWriteAllowed(toolName: string): void {
  if (!isWriteEnabled()) throw new WriteDeniedError(toolName);
  const allow = parseList('MCP_WRITE_ALLOWLIST');
  // Empty allowlist = deny. Operators must opt every tool in explicitly.
  if (allow.size === 0 || !allow.has(toolName)) throw new WriteDeniedError(toolName);
}

/**
 * Gate a destructive (record-deleting) tool. Must be called *after* a normal
 * write check; it adds a second allowlist + a shared-secret confirm token.
 * @param toolName     The exact MCP tool name (e.g. `jira.delete_issue`).
 * @param confirmToken Value the caller passed in their tool arguments.
 */
export function assertDestructiveAllowed(toolName: string, confirmToken: string | undefined): void {
  // Inherit Tier 1 first — never run destructive code if writes are disabled.
  assertWriteAllowed(toolName);

  const destructive = parseList('MCP_DESTRUCTIVE_ALLOWLIST');
  if (!destructive.has(toolName)) throw new WriteDeniedError(toolName);

  const expected = process.env['MCP_DESTRUCTIVE_CONFIRM']?.trim();
  if (!expected || expected.length < MIN_CONFIRM_LENGTH) throw new WriteDeniedError(toolName);
  if (typeof confirmToken !== 'string' || !constantTimeEquals(confirmToken, expected)) {
    throw new WriteDeniedError(toolName);
  }
}

/** Constant-time equality; equal-length pre-check is fine — only the secret's length leaks. */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

/**
 * Tier 3 — caller must echo the resource's current human-readable name.
 *
 * Call this AFTER {@link assertDestructiveAllowed} succeeds and AFTER the handler
 * has fetched the live resource. Constant-time string compare keeps the shape
 * identical to {@link assertDestructiveAllowed}; resource names are not secrets,
 * but the consistency avoids accidental short-circuit early-exits in the future.
 *
 * Refuses when:
 *   - `actualResourceName` is empty (resource has no displayable name — refuse
 *     for safety; the operator should fall back to a stricter manual flow);
 *   - `providedResourceName` is missing, empty, or does not exactly match.
 *
 * Comparison is case-sensitive and exact (no whitespace trimming). The agent
 * MUST quote the name verbatim, including capitalisation and punctuation.
 *
 * @param toolName              Exact MCP tool name (e.g. `confluence.delete_page`).
 * @param actualResourceName    Fresh name read from upstream GET right before the delete.
 * @param providedResourceName  Value the caller passed in their tool arguments.
 */
export function assertResourceConfirmation(
  toolName: string,
  actualResourceName: string,
  providedResourceName: string | undefined,
): void {
  if (actualResourceName.length === 0) {
    throw new ConfirmationError(
      `${toolName}: target resource has no displayable name; refusing destructive op for safety.`,
      toolName,
    );
  }
  if (typeof providedResourceName !== 'string' || providedResourceName.length === 0) {
    throw new ConfirmationError(
      `${toolName}: provide \`confirmResourceName\` matching the resource's current name "${actualResourceName}" exactly (case-sensitive).`,
      toolName,
    );
  }
  if (!constantTimeEquals(providedResourceName, actualResourceName)) {
    throw new ConfirmationError(
      `${toolName}: \`confirmResourceName\` does not match the resource's current name. ` +
        `Expected "${actualResourceName}" exactly (case-sensitive, no trimming).`,
      toolName,
    );
  }
}
