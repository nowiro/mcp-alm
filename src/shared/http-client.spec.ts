/**
 * Unit tests for http-client — covers SSRF guard, retry/backoff, in-flight
 * dedup, ETag/304 cache, body cap, response-mode (json vs text).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkError, RateLimitError, UpstreamError } from './errors.js';
import { createHttpClient } from './http-client.js';

const auth = {
  tool: 'gitlab' as const,
  baseUrl: 'https://api.example.com',
  token: 'tok',
};

interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

function stringifyInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockFetchSequence(responses: readonly MockResponse[]): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: stringifyInput(input), init });
    const r = responses[Math.min(index, responses.length - 1)];
    if (!r) throw new Error('mock fetch: no response configured');
    index += 1;
    // 204 / 304 must have a null body per the fetch spec.
    const bodyForbidden = r.status === 204 || r.status === 304;
    const body = bodyForbidden ? null : (r.body ?? '');
    const stream =
      body === null
        ? null
        : new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          });
    return new Response(stream, {
      status: r.status,
      headers: r.headers,
    });
  });
  return { fetch: mock, calls };
}

beforeEach(() => {
  delete process.env['MCP_ALM_ALLOW_PRIVATE_HOSTS'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('http-client SSRF guard', () => {
  it('blocks loopback hosts', async () => {
    const client = createHttpClient(
      { tool: 'gitlab', baseUrl: 'http://127.0.0.1', token: 'x' },
      { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' },
    );
    await expect(client.request({ path: '/x' })).rejects.toBeInstanceOf(NetworkError);
  });

  it('blocks RFC1918 hosts (10.x)', async () => {
    const client = createHttpClient(
      { tool: 'gitlab', baseUrl: 'http://10.0.0.1', token: 'x' },
      { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' },
    );
    await expect(client.request({ path: '/x' })).rejects.toBeInstanceOf(NetworkError);
  });

  it('blocks link-local 169.254.x', async () => {
    const client = createHttpClient(
      { tool: 'gitlab', baseUrl: 'http://169.254.169.254', token: 'x' },
      { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' },
    );
    await expect(client.request({ path: '/x' })).rejects.toBeInstanceOf(NetworkError);
  });

  it('allows private hosts when escape hatch is set', async () => {
    process.env['MCP_ALM_ALLOW_PRIVATE_HOSTS'] = 'true';
    const { fetch } = mockFetchSequence([{ status: 200, body: '{"ok":true}' }]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(
      { tool: 'gitlab', baseUrl: 'http://127.0.0.1:8080', token: 'x' },
      { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' },
    );
    await expect(client.request<{ ok: boolean }>({ path: '/x' })).resolves.toEqual({ ok: true });
  });
});

describe('http-client retry / backoff', () => {
  it('retries on 429 honouring Retry-After', async () => {
    const { fetch, calls } = mockFetchSequence([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200, body: '{"ok":true}' },
    ]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    const result = await client.request<{ ok: boolean }>({ path: '/x' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries on 5xx', async () => {
    const { fetch, calls } = mockFetchSequence([{ status: 503 }, { status: 200, body: '{"ok":true}' }]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    await client.request({ path: '/x' });
    expect(calls).toHaveLength(2);
  });

  it('gives up after MAX_ATTEMPTS and surfaces RateLimitError', async () => {
    const { fetch } = mockFetchSequence([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '0' } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    await expect(client.request({ path: '/x' })).rejects.toBeInstanceOf(RateLimitError);
  });

  it('does NOT retry on 4xx (other than 429)', async () => {
    const { fetch, calls } = mockFetchSequence([{ status: 404 }]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    await expect(client.request({ path: '/x' })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('http-client in-flight dedup', () => {
  it('coalesces parallel identical GETs into one upstream call', async () => {
    let resolveResponse: () => void = () => undefined;
    const blocking = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls += 1;
      await blocking;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"hit":${calls}}`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    const [a, b, c] = [
      client.request<{ hit: number }>({ path: '/same' }),
      client.request<{ hit: number }>({ path: '/same' }),
      client.request<{ hit: number }>({ path: '/same' }),
    ];
    resolveResponse();
    const results = await Promise.all([a, b, c]);
    expect(calls).toBe(1);
    expect(results[0].hit).toBe(1);
    expect(results[1].hit).toBe(1);
    expect(results[2].hit).toBe(1);
  });

  it('does NOT coalesce POSTs (non-idempotent)', async () => {
    const { fetch, calls } = mockFetchSequence([
      { status: 200, body: '{"ok":1}' },
      { status: 200, body: '{"ok":2}' },
    ]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    await Promise.all([
      client.request({ method: 'POST', path: '/x', body: { a: 1 } }),
      client.request({ method: 'POST', path: '/x', body: { a: 1 } }),
    ]);
    expect(calls.length).toBe(2);
  });

  it('cleans up the in-flight map after success (next call re-fetches)', async () => {
    const { fetch, calls } = mockFetchSequence([
      { status: 200, body: '{"ok":1}' },
      { status: 200, body: '{"ok":2}' },
    ]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    await client.request({ path: '/same' });
    await client.request({ path: '/same' });
    // Both calls hit upstream because dedup only covers in-flight concurrency.
    // (ETag cache layer is tested separately.)
    expect(calls.length).toBe(2);
  });
});

describe('http-client ETag / 304 cache', () => {
  it('sends If-None-Match on second call when first returned an ETag', async () => {
    const { fetch, calls } = mockFetchSequence([
      { status: 200, headers: { etag: '"v1"' }, body: '{"ok":true}' },
      { status: 304, headers: { etag: '"v1"' } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    const first = await client.request<{ ok: boolean }>({ path: '/cacheable' });
    expect(first.ok).toBe(true);
    const second = await client.request<{ ok: boolean }>({ path: '/cacheable' });
    expect(second.ok).toBe(true);
    expect(calls[1]?.init?.headers).toMatchObject({ 'if-none-match': '"v1"' });
  });
});

describe('http-client concurrency limit', () => {
  beforeEach(() => {
    delete process.env['MCP_ALM_HTTP_CONCURRENCY'];
  });

  it('caps in-flight upstream requests at MCP_ALM_HTTP_CONCURRENCY', async () => {
    process.env['MCP_ALM_HTTP_CONCURRENCY'] = '2';
    let inflight = 0;
    let peak = 0;
    const releasers: (() => void)[] = [];
    const mockFetch = vi.fn(async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      // Each call parks on its own promise so the test can release them one-by-one.
      await new Promise<void>((resolve) => releasers.push(resolve));
      inflight -= 1;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    const promises = [0, 1, 2, 3].map((i) => client.request({ path: `/p${i}` }));
    // Drain: each release lets ONE in-flight call complete; the next one in
    // the semaphore queue then enters fetch. We never see > 2 parked at once.
    for (let i = 0; i < 4; i += 1) {
      while (releasers.length === 0) await Promise.resolve();
      releasers.shift()?.();
      // Two microtask yields: one for the awaited promise to settle, one for
      // the next caller to acquire the permit and hit fetch.
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(promises);
    expect(peak).toBeLessThanOrEqual(2);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

describe('http-client response modes', () => {
  it('returns raw text when responseMode is "text"', async () => {
    const { fetch, calls } = mockFetchSequence([{ status: 200, body: 'diff --git a/x b/x' }]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    const result = await client.request<string>({
      path: '/diff',
      responseMode: 'text',
      accept: 'application/vnd.github.v3.diff',
    });
    expect(result).toBe('diff --git a/x b/x');
    expect(calls[0]?.init?.headers).toMatchObject({ accept: 'application/vnd.github.v3.diff' });
  });

  it('rejects body that is not valid JSON in json mode', async () => {
    const { fetch } = mockFetchSequence([{ status: 200, body: '<html>oops</html>' }]);
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient(auth, { userAgent: 'test/1.0', serverName: 'test', serverVersion: '1.0' });
    await expect(client.request({ path: '/x' })).rejects.toBeInstanceOf(UpstreamError);
  });
});
