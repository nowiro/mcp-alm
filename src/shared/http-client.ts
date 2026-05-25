/**
 * Tiny HTTP client over native fetch. Owns five cross-cutting concerns so the
 * per-server handlers stay one-liners:
 *
 *   1. **Auth header injection** built out of band — the Authorization value
 *      never enters the rest of the codebase, never reaches the logger.
 *   2. **Timeouts** (default 15 s, override per request).
 *   3. **SSRF guard** — outbound URL must resolve to a hostname that is NOT
 *      loopback / link-local / RFC1918 (unless `MCP_ALM_ALLOW_PRIVATE_HOSTS=true`).
 *   4. **Retry + jittered backoff** on `429` and `5xx` (3 tries by default,
 *      honours `Retry-After` seconds or HTTP-date).
 *   5. **In-flight request dedup** — identical idempotent (GET/HEAD) requests
 *      issued in parallel are coalesced into ONE upstream call. The follow-ups
 *      await the first promise and get the same body. This is the answer to
 *      "agent fires the same query 3× in a row" loops.
 *   6. **ETag/304 cache** — server returns an ETag → we store body. Next call
 *      sends `If-None-Match`; a 304 returns the cached body without re-parsing.
 *   7. **Response body cap** — refuse to buffer > `MAX_BODY_BYTES` (50 MB).
 *
 * Keep this file dependency-free (no axios — see `.github/instructions/core.instructions.md`).
 */
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';

import { AuthError, NetworkError, NotFoundError, RateLimitError, UpstreamError } from './errors.js';
import { LruCache } from './llm-optimize.js';
import { sessionTracker } from './session-tracker.js';
import { getRepoVersion } from './version.js';
import type { AuthConfig } from './auth.js';

/** ESM-safe handle to CommonJS `require`, used to lazy-load undici only when a proxy is configured. */
const nodeRequire = createRequire(import.meta.url);

/** Hard ceiling on a single response body before we abort. */
const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB
/** Number of retry attempts on 429 / 5xx (the initial call counts as 1). */
const MAX_ATTEMPTS = 3;
/** Cap on Retry-After honour — runaway upstream should not block us forever. */
const MAX_RETRY_AFTER_MS = 30_000;
/** Default jitter window for exponential backoff (base × 2^attempt + rand 0..jitter). */
const BACKOFF_BASE_MS = 250;
const BACKOFF_JITTER_MS = 250;
/** ETag / 304 cache: 200 entries × 10 min TTL — plenty for field-registry & project lists. */
const ETAG_CACHE_CAPACITY = 200;
const ETAG_CACHE_TTL_MS = 10 * 60 * 1000;
/** Default max concurrent in-flight upstream requests per HttpClient. Tunable via MCP_ALM_HTTP_CONCURRENCY. */
const DEFAULT_CONCURRENCY = 6;

function resolveConcurrency(): number {
  const raw = process.env['MCP_ALM_HTTP_CONCURRENCY'];
  if (!raw) return DEFAULT_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.floor(parsed);
}

/**
 * Tiny FIFO semaphore. Counts permits; if exhausted, `acquire()` parks the
 * caller on a queue until `release()` is called. Used to prevent a single
 * `extract` pulling 50 pages in parallel from spinning up 50 sockets at once.
 */
class Semaphore {
  private permits: number;
  private readonly queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

/** What the caller wants back from the upstream — JSON parsing is the default. */
export type ResponseMode = 'json' | 'text';

interface HttpRequest {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  /** Override `Accept`. Default is `application/json` (or `text/plain` when `responseMode='text'`). */
  readonly accept?: string;
  /** `'json'` (default) returns parsed JSON; `'text'` returns the raw string body (used for diff endpoints). */
  readonly responseMode?: ResponseMode;
  /** Forwarded as `x-request-id` so upstream audit logs can be joined to MCP traces. */
  readonly correlationId?: string;
  /** Tool name; surfaces in the outbound `User-Agent` so rate-limit dashboards can attribute. */
  readonly tool?: string;
  /** Set to `false` to bypass in-flight dedup + ETag cache for this call. Defaults to `true` for GET/HEAD. */
  readonly cache?: boolean;
  /**
   * Optional caller-supplied `AbortSignal`. When set, it is combined with the
   * internal timeout controller via `AbortSignal.any([ctxSignal, timeoutSignal])`.
   * An aborted call throws `NetworkError` and is NOT retried.
   */
  readonly abortSignal?: AbortSignal;
}

export interface HttpClient {
  request<T>(req: HttpRequest): Promise<T>;
}

export interface HttpClientOptions {
  /** Full server identifier — e.g. `mcp-jira/0.1.0`. Sent as `User-Agent` per RFC 7231. */
  readonly userAgent: string;
  /** Server name without version — e.g. `mcp-jira`. Sent as `X-MCP-Server`. */
  readonly serverName: string;
  /** Server semver — e.g. `0.1.0`. Sent as `X-MCP-Version`. */
  readonly serverVersion: string;
}

/** Build the auth header name + value per tool. Atlassian → Basic; Figma → X-Figma-Token; rest → Bearer. */
function buildAuthHeader(auth: AuthConfig): { readonly name: string; readonly value: string } {
  switch (auth.tool) {
    case 'jira':
    case 'confluence': {
      const token = Buffer.from(`${auth.email}:${auth.token}`).toString('base64');
      return { name: 'authorization', value: `Basic ${token}` };
    }
    case 'figma': {
      // Figma's REST API ignores `Authorization: Bearer` and reads the raw token
      // from `X-Figma-Token`. See https://www.figma.com/developers/api#authentication.
      return { name: 'x-figma-token', value: auth.token };
    }
    case 'sonar':
    case 'gitlab': {
      return { name: 'authorization', value: `Bearer ${auth.token}` };
    }
  }
}

function buildUrl(baseUrl: string, path: string, query?: HttpRequest['query']): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const SPECIAL_PRIVATE_HOSTS = new Set(['localhost', '0.0.0.0', '::1', '::']);

/** Block link-local + loopback + RFC1918 unless explicitly allowed. */
function assertHostnameAllowed(url: string): void {
  if (process.env['MCP_ALM_ALLOW_PRIVATE_HOSTS']?.toLowerCase() === 'true') return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new NetworkError(`invalid URL: ${url}`);
  }
  if (SPECIAL_PRIVATE_HOSTS.has(host)) {
    throw new NetworkError(`SSRF guard: refusing to call ${host}`);
  }
  const v4Reason = ipv4PrivateReason(host);
  if (v4Reason) throw new NetworkError(`SSRF guard: ${v4Reason} ${host}`);
  // IPv6 loopback + link-local prefixes (bracketed form from new URL().hostname is unwrapped).
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    throw new NetworkError(`SSRF guard: private IPv6 host ${host}`);
  }
}

/** Returns the SSRF reason if the host is a private IPv4; `undefined` otherwise. */
function ipv4PrivateReason(host: string): string | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return undefined;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 127) return 'loopback host';
  if (a === 10) return 'RFC1918 host';
  if (a === 169 && b === 254) return 'link-local host';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 host';
  if (a === 192 && b === 168) return 'RFC1918 host';
  if (a === 0) return 'invalid host';
  return undefined;
}

/** Parse `Retry-After` — accepts seconds OR an HTTP-date. Returns ms (capped). */
function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const ms = Date.parse(value) - Date.now();
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
  return 0;
}

function backoffDelayMs(attempt: number, retryAfter: number): number {
  if (retryAfter > 0) return retryAfter;
  const exponential = BACKOFF_BASE_MS * 2 ** attempt;
  // `randomInt` is overkill for jitter but keeps sonarjs/pseudo-random happy and
  // costs effectively nothing on this hot path.
  const jitter = randomInt(0, BACKOFF_JITTER_MS);
  return exponential + jitter;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve undici `ProxyAgent` dispatcher for a given URL — or undefined when
 * the proxy is not configured, disabled, or the host is on `NO_PROXY`.
 *
 * Honours `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (lowercase too) plus the
 * override `MCP_ALM_DISABLE_PROXY=true`. Undici is loaded lazily so the
 * dependency is only resolved when a proxy is actually in use.
 *
 * `NO_PROXY` format: CSV of hosts / domains (`.your-org.internal,localhost,127.0.0.1`).
 * Suffix matching for leading-dot patterns — `.your-org.internal` matches both
 * `api.your-org.internal` and `your-org.internal`.
 *
 * Note: the dispatcher is cached per proxy URL (one instance per proxy) — a
 * ProxyAgent keeps a keep-alive pool, so re-creating it per request wastes
 * sockets.
 */
let cachedProxyDispatcher: { readonly proxyUrl: string; readonly agent: unknown } | undefined;

/** Pick proxy URL from env: HTTPS_PROXY (https URLs) / HTTP_PROXY (http) / ALL_PROXY (fallback). Both cases honoured. */
function resolveProxyUrl(url: string): string | undefined {
  const isHttps = url.startsWith('https:');
  const primary = isHttps
    ? (process.env['HTTPS_PROXY'] ?? process.env['https_proxy'])
    : (process.env['HTTP_PROXY'] ?? process.env['http_proxy']);
  return primary ?? process.env['ALL_PROXY'] ?? process.env['all_proxy'];
}

/** True iff `url`'s hostname is matched by `NO_PROXY` (CSV; `.foo.com` → suffix match). */
function isHostInNoProxy(url: string): boolean {
  const noProxy = process.env['NO_PROXY'] ?? process.env['no_proxy'];
  if (!noProxy) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const patterns = noProxy
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (pattern.startsWith('.')) {
      if (hostname === pattern.slice(1) || hostname.endsWith(pattern)) return true;
    } else if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

function resolveProxyDispatcher(url: string): unknown {
  if (process.env['MCP_ALM_DISABLE_PROXY']?.toLowerCase() === 'true') return undefined;
  const proxyUrl = resolveProxyUrl(url);
  if (!proxyUrl) return undefined;
  if (isHostInNoProxy(url)) return undefined;
  if (cachedProxyDispatcher?.proxyUrl === proxyUrl) return cachedProxyDispatcher.agent;

  // Lazy import undici (już w node_modules jako transitive deps, ale unikamy top-level import).
  const undici = loadUndici();
  if (!undici) return undefined;
  const agent = new undici.ProxyAgent(proxyUrl);
  cachedProxyDispatcher = { proxyUrl, agent };
  return agent;
}

interface UndiciModule {
  readonly ProxyAgent: new (url: string) => unknown;
}
let undiciCache: UndiciModule | null | undefined;
function loadUndici(): UndiciModule | undefined {
  if (undiciCache !== undefined) return undiciCache ?? undefined;
  try {
    const module_ = nodeRequire('undici') as UndiciModule;
    undiciCache = module_;
    return module_;
  } catch {
    process.stderr.write('[http-client] warning: HTTP_PROXY set but undici not available; proxy ignored.\n');
    undiciCache = null;
    return undefined;
  }
}

interface CachedResponse {
  readonly etag: string;
  readonly body: string;
  readonly mode: ResponseMode;
}

/** Per-client cache + in-flight map; both live as long as the HttpClient itself. */
interface ClientState {
  readonly etagCache: LruCache<CachedResponse>;
  readonly inflight: Map<string, Promise<unknown>>;
  readonly semaphore: Semaphore;
}

/**
 * Convenience wrapper nad `createHttpClient` z konwencyjnymi nagłówkami
 * identyfikującymi producenta. Wszystkie 5 serwerów MCP i 4 skrypty extract
 * ustawiają identyczny shape opcji — `userAgent = ${name}/${version}` +
 * `serverName = name` + `serverVersion = version` — więc wystarczy podać
 * `name` (np. `mcp-jira` lub `extract-jira`), reszta jest derived z
 * `getRepoVersion()`.
 *
 * Jeśli potrzebujesz custom optionów (np. inny User-Agent), użyj
 * `createHttpClient` bezpośrednio.
 */
export function createNamedHttpClient(name: string, auth: AuthConfig): HttpClient {
  const version = getRepoVersion();
  return createHttpClient(auth, {
    userAgent: `${name}/${version}`,
    serverName: name,
    serverVersion: version,
  });
}

export function createHttpClient(auth: AuthConfig, options: HttpClientOptions): HttpClient {
  const authHeader = buildAuthHeader(auth);
  const state: ClientState = {
    etagCache: new LruCache<CachedResponse>(ETAG_CACHE_CAPACITY, ETAG_CACHE_TTL_MS),
    inflight: new Map(),
    semaphore: new Semaphore(resolveConcurrency()),
  };

  return {
    async request<T>(req: HttpRequest): Promise<T> {
      const method = req.method ?? 'GET';
      const isIdempotent = method === 'GET' || method === 'HEAD';
      const cacheable = isIdempotent && req.cache !== false;
      const url = buildUrl(auth.baseUrl, req.path, req.query);
      assertHostnameAllowed(url);

      // ─ In-flight dedup ─────────────────────────────────────────────────────
      // Identical concurrent GETs share one upstream round-trip. The follow-ups
      // await the in-flight promise and receive the parsed body of the first.
      const cacheKey = cacheable ? `${method} ${url}` : undefined;
      if (cacheKey) {
        const inflight = state.inflight.get(cacheKey) as Promise<T> | undefined;
        if (inflight) {
          sessionTracker.bumpHttp('dedupHits');
          return inflight;
        }
      }

      const promise = executeWithCleanup<T>(auth, authHeader, options, state, req, url, method, cacheable, cacheKey);
      if (cacheKey) state.inflight.set(cacheKey, promise);
      return promise;
    },
  };
}

interface AuthHeader {
  readonly name: string;
  readonly value: string;
}

/** Wrap `executeRequest` with cache cleanup that survives rejection. */
async function executeWithCleanup<T>(
  auth: AuthConfig,
  authHeader: AuthHeader,
  options: HttpClientOptions,
  state: ClientState,
  req: HttpRequest,
  url: string,
  method: string,
  cacheable: boolean,
  cacheKey: string | undefined,
): Promise<T> {
  try {
    return await executeRequest<T>(auth, authHeader, options, state, req, url, method, cacheable);
  } finally {
    if (cacheKey) state.inflight.delete(cacheKey);
  }
}

/** Single-attempt-with-retries body. Split out so dedup wraps it cleanly. */
async function executeRequest<T>(
  auth: AuthConfig,
  authHeader: AuthHeader,
  options: HttpClientOptions,
  state: ClientState,
  req: HttpRequest,
  url: string,
  method: string,
  cacheable: boolean,
): Promise<T> {
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    try {
      return await singleAttempt<T>(auth, authHeader, options, state, req, url, method, cacheable);
    } catch (error: unknown) {
      const delay = retryDelayFor(error, attempt);
      if (delay === undefined) {
        if (attempt > 0) sessionTracker.bumpHttp('retriesExhausted');
        throw error;
      }
      countRetry(error);
      await sleep(delay);
      attempt += 1;
    }
  }
  sessionTracker.bumpHttp('retriesExhausted');
  // Unreachable — the last attempt re-throws via `delay === undefined`.
  throw new UpstreamError(0, `${auth.tool} ${req.path}: max retries exhausted`, auth.tool);
}

function countRetry(error: unknown): void {
  if (error instanceof RateLimitError) sessionTracker.bumpHttp('retries429');
  else if (error instanceof UpstreamError) sessionTracker.bumpHttp('retries5xx');
  else if (error instanceof NetworkError) sessionTracker.bumpHttp('retriesNetwork');
}

/** Return ms to wait before next attempt, or `undefined` to give up. */
function retryDelayFor(error: unknown, attempt: number): number | undefined {
  if (attempt >= MAX_ATTEMPTS - 1) return undefined;
  if (error instanceof RateLimitError) {
    return backoffDelayMs(attempt, (error.retryAfterSeconds ?? 0) * 1000);
  }
  if (error instanceof UpstreamError && error.statusCode >= 500) {
    return backoffDelayMs(attempt, 0);
  }
  if (error instanceof NetworkError) {
    return backoffDelayMs(attempt, 0);
  }
  return undefined;
}

async function singleAttempt<T>(
  auth: AuthConfig,
  authHeader: AuthHeader,
  options: HttpClientOptions,
  state: ClientState,
  req: HttpRequest,
  url: string,
  method: string,
  cacheable: boolean,
): Promise<T> {
  const responseMode: ResponseMode = req.responseMode ?? 'json';
  const cacheEntryKey = `${method} ${url}`;
  const cached = cacheable ? state.etagCache.get(cacheEntryKey) : undefined;

  sessionTracker.bumpHttp('upstreamCalls');
  await state.semaphore.acquire();
  let response: Response;
  try {
    response = await fetchWithTimeout(auth, authHeader, options, req, url, method, cached?.etag, responseMode);
  } finally {
    state.semaphore.release();
  }
  recordRateLimit(response, req.correlationId);

  if (response.status === 304 && cached?.mode === responseMode) {
    sessionTracker.bumpHttp('cacheHits');
    return parseBody(cached.body, responseMode) as T;
  }
  rejectByStatus(response, auth.tool, req.path);

  const body = await readBodyCapped(response);
  if (cacheable) {
    const etag = response.headers.get('etag');
    if (etag) {
      state.etagCache.set(cacheEntryKey, { etag, body, mode: responseMode });
      sessionTracker.bumpHttp('cacheStores');
    }
  }
  return parseBody(body, responseMode) as T;
}

/**
 * Parse the upstream rate-limit headers (GitHub-style + Jira-style) and stash
 * the snapshot in the session tracker keyed by correlationId. `mcp-server.ts`
 * picks it up after the handler resolves and folds it into `_meta.rateLimit`.
 */
function recordRateLimit(response: Response, correlationId: string | undefined): void {
  if (!correlationId) return;
  const remainingHeader = response.headers.get('x-ratelimit-remaining') ?? response.headers.get('ratelimit-remaining');
  const limitHeader = response.headers.get('x-ratelimit-limit') ?? response.headers.get('ratelimit-limit');
  const resetHeader = response.headers.get('x-ratelimit-reset') ?? response.headers.get('ratelimit-reset');

  const remaining = remainingHeader === null ? undefined : Number(remainingHeader);
  const limit = limitHeader === null ? undefined : Number(limitHeader);
  let resetAt: string | undefined;
  if (resetHeader !== null) {
    const asNumber = Number(resetHeader);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      // GitHub returns epoch seconds; values < 10^10 are seconds, larger are ms.
      resetAt = new Date(asNumber < 1e10 ? asNumber * 1000 : asNumber).toISOString();
    } else if (!Number.isNaN(Date.parse(resetHeader))) {
      resetAt = new Date(resetHeader).toISOString();
    }
  }

  sessionTracker.recordRateLimit(correlationId, {
    ...(Number.isFinite(remaining) ? { remaining } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(resetAt ? { resetAt } : {}),
  });
}

interface FetchHeaderBundle {
  readonly authHeader: AuthHeader;
  readonly options: HttpClientOptions;
  readonly req: HttpRequest;
  readonly etag?: string;
  readonly responseMode: ResponseMode;
}

function buildHeaders(bundle: FetchHeaderBundle): Record<string, string> {
  const { authHeader, options, req, etag, responseMode } = bundle;
  const acceptHeader = req.accept ?? (responseMode === 'text' ? 'text/plain, */*' : 'application/json');
  return {
    [authHeader.name]: authHeader.value,
    accept: acceptHeader,
    'user-agent': options.userAgent,
    'x-mcp-server': options.serverName,
    'x-mcp-version': options.serverVersion,
    ...(req.tool ? { 'x-mcp-tool': req.tool } : {}),
    ...(req.correlationId ? { 'x-request-id': req.correlationId } : {}),
    ...(etag ? { 'if-none-match': etag } : {}),
    ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
  };
}

async function fetchWithTimeout(
  auth: AuthConfig,
  authHeader: AuthHeader,
  options: HttpClientOptions,
  req: HttpRequest,
  url: string,
  method: string,
  etag: string | undefined,
  responseMode: ResponseMode,
): Promise<Response> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort();
  }, req.timeoutMs ?? 15_000);

  // Combine timeout + caller-supplied abort signal so cancellation propagates.
  const signal = req.abortSignal
    ? AbortSignal.any([timeoutController.signal, req.abortSignal])
    : timeoutController.signal;

  // Optional HTTP/HTTPS proxy via undici.ProxyAgent. Resolved per-call so an
  // env mutation in tests / shell takes effect immediately (no process restart).
  const dispatcher = resolveProxyDispatcher(url);
  const init: RequestInit & { dispatcher?: unknown } = {
    method,
    headers: buildHeaders({ authHeader, options, req, etag, responseMode }),
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal,
  };
  if (dispatcher) init.dispatcher = dispatcher;

  try {
    return await fetch(url, init);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Distinguish internal timeout vs external abort (e.g. MCP context cancellation).
      const reason = req.abortSignal?.aborted ? 'cancelled' : 'timed out';
      throw new NetworkError(`${auth.tool} ${req.path} ${reason}`, auth.tool);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new NetworkError(`${auth.tool} ${req.path}: ${message}`, auth.tool);
  } finally {
    clearTimeout(timer);
  }
}

function rejectByStatus(response: Response, tool: string, path: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`${tool} returned ${response.status} for ${path}`, tool);
  }
  if (response.status === 404) {
    throw new NotFoundError(`${tool} ${path} not found`, tool);
  }
  if (response.status === 429) {
    throw new RateLimitError(`${tool} rate-limited`, parseRetryAfterSeconds(response), tool);
  }
  if (response.status >= 500) {
    throw new UpstreamError(response.status, `${tool} upstream error`, tool);
  }
  if (!response.ok && response.status !== 304) {
    throw new UpstreamError(response.status, `${tool} ${path}: status ${response.status}`, tool);
  }
}

function parseRetryAfterSeconds(response: Response): number | undefined {
  const ms = parseRetryAfter(response.headers.get('retry-after'));
  return ms > 0 ? Math.ceil(ms / 1000) : undefined;
}

async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let out = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
      throw new UpstreamError(0, `response body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function parseBody(body: string, mode: ResponseMode): unknown {
  if (mode === 'text') return body;
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new UpstreamError(0, `response was not valid JSON (first 80 chars: ${body.slice(0, 80)})`);
  }
}
