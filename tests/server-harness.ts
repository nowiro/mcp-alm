/**
 * Server integration harness — exercises a real `server-*.ts` tool handler end
 * to end (input parse → URL/query construction → reshape → output) with `fetch`
 * stubbed. Closes the gap where handler HTTP wiring was only typecheck-guaranteed.
 *
 * Why a harness: servers boot at import (`loadXxxAuth()` throws without env) and
 * register write tools only when `MCP_WRITE_ENABLED` is set. We set dummy auth +
 * `MCP_NO_BOOT=true` + write-enabled BEFORE the dynamic import, grab the exported
 * `tools`, and invoke `handle()` directly. SSRF only flags numeric private IPs, so
 * a hostname base URL (`jira.example.com`) passes without DNS; `fetch` is bare-called
 * at request time, so `vi.stubGlobal` reaches the module-level client.
 *
 * Test-only (lives under `tests/`, never shipped).
 */
import { vi } from 'vitest';

export interface MockResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

interface Tool {
  readonly name: string;
  readonly inputSchema: { parse(input: unknown): unknown };
  handle(input: unknown, ctx: unknown): Promise<unknown>;
}

function ensureEnv(): void {
  process.env['JIRA_BASE_URL'] = 'https://jira.example.com';
  process.env['JIRA_EMAIL'] = 'tester@example.com';
  process.env['JIRA_TOKEN'] = 'dummy-token';
  process.env['MCP_NO_BOOT'] = 'true';
  process.env['MCP_WRITE_ENABLED'] = 'true';
  process.env['MCP_WRITE_ALLOWLIST'] = 'jira.move_issues_to_sprint';
}

let cached: readonly Tool[] | undefined;

export async function loadJiraTools(): Promise<readonly Tool[]> {
  ensureEnv();
  cached ??= ((await import('../src/server-jira.js')) as { tools: readonly Tool[] }).tools;
  return cached;
}

/** Build a fetch mock that records calls and replays canned responses in order. */
export function mockFetch(responses: readonly MockResponse[]): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const r = responses[Math.min(index, responses.length - 1)];
    if (!r) throw new Error('mock fetch: no response configured');
    index += 1;
    const forbidden = r.status === 204 || r.status === 304;
    const body = forbidden ? null : (r.body ?? '');
    const stream =
      body === null
        ? null
        : new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          });
    return new Response(stream, { status: r.status, headers: r.headers });
  });
  return { fetch: mock as unknown as typeof fetch, calls };
}

export function makeCtx(toolName: string): unknown {
  return {
    correlationId: 'test-corr',
    server: 'mcp-jira',
    version: '0.0.0',
    tool: toolName,
    logger: { log: () => undefined, timed: (_a: unknown, fn: () => Promise<unknown>) => fn() },
  };
}

/** Find a tool, parse raw input via its schema, invoke `handle` with stubbed fetch. */
export async function invokeTool(
  name: string,
  rawInput: unknown,
  responses: readonly MockResponse[] = [],
): Promise<{ out: unknown; calls: { url: string; init?: RequestInit }[] }> {
  const tools = await loadJiraTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not registered: ${name} (have: ${tools.map((t) => t.name).join(', ')})`);
  const { fetch: stub, calls } = mockFetch(responses);
  vi.stubGlobal('fetch', stub);
  try {
    const parsed = tool.inputSchema.parse(rawInput);
    const out = await tool.handle(parsed, makeCtx(name));
    return { out, calls };
  } finally {
    vi.unstubAllGlobals();
  }
}
