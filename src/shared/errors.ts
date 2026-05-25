/**
 * Typed error hierarchy for mcp-alm. Each error maps to a stable MCP error
 * code so the client / orchestrator can route — auth → ask user; rate-limit
 * → retry; etc.
 *
 * See `.github/instructions/mcp-server.instructions.md` §5 for the contract.
 */

/** Base error — never throw this directly; subclass instead. */
export class AlmError extends Error {
  override readonly name: string;
  readonly code: number;
  readonly tool?: string;

  constructor(name: string, code: number, message: string, tool?: string) {
    super(message);
    this.name = name;
    this.code = code;
    this.tool = tool;
  }
}

/** 401 / 403 from upstream — token missing, expired, or insufficient scope. */
export class AuthError extends AlmError {
  constructor(message: string, tool?: string) {
    super('AuthError', -32_001, message, tool);
  }
}

/** 404 — referenced resource doesn't exist. */
export class NotFoundError extends AlmError {
  constructor(message: string, tool?: string) {
    super('NotFoundError', -32_002, message, tool);
  }
}

/** 429 — upstream rate limit. The orchestrator should retry with backoff. */
export class RateLimitError extends AlmError {
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number, tool?: string) {
    super('RateLimitError', -32_003, message, tool);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 5xx — upstream is broken. Surface to user; not auto-retried. */
export class UpstreamError extends AlmError {
  readonly statusCode: number;

  constructor(statusCode: number, message: string, tool?: string) {
    super('UpstreamError', -32_004, message, tool);
    this.statusCode = statusCode;
  }
}

/** Transport-level failure (DNS, TCP, TLS, abort, SSRF guard). Retryable. */
export class NetworkError extends AlmError {
  constructor(message: string, tool?: string) {
    super('NetworkError', -32_006, message, tool);
  }
}

/** Tool requested a write but `MCP_WRITE_ENABLED` is false or the tool isn't on the allowlist. */
export class WriteDeniedError extends AlmError {
  constructor(toolName: string) {
    super(
      'WriteDeniedError',
      -32_005,
      `Write tool "${toolName}" denied. Set MCP_WRITE_ENABLED=true and add to MCP_WRITE_ALLOWLIST.`,
      toolName,
    );
  }
}

/** Input violated a semantic constraint (mutually-exclusive params, business-rule check). */
export class ValidationError extends AlmError {
  constructor(message: string, tool?: string) {
    super('ValidationError', -32_007, message, tool);
  }
}

/** Defence-in-depth guard tripped (path traversal, SSRF preflight) — caller is buggy or malicious. */
export class SecurityError extends AlmError {
  constructor(message: string, tool?: string) {
    super('SecurityError', -32_008, message, tool);
  }
}

/**
 * Third-tier destructive guard tripped — caller did not echo the resource's
 * current human-readable name. Distinct from {@link WriteDeniedError} because
 * the remediation is "fetch the resource and pass its name", not "set env vars".
 */
export class ConfirmationError extends AlmError {
  constructor(message: string, tool?: string) {
    super('ConfirmationError', -32_009, message, tool);
  }
}
