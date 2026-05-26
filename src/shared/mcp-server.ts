/**
 * One-stop MCP server factory. Wires together transport, request dispatch,
 * input validation (Zod → JSON Schema), structured logging, per-call
 * correlation, the `{ data, _meta }` response envelope, and session-level
 * token-cost tracking.
 *
 * Every connector reduces to declaring its tools and calling
 * `startMcpServer({ name, tools })`. The factory makes sure that:
 *   - the inbound `_meta.correlationId` (if any) survives end-to-end,
 *   - the result is wrapped once with `tokensEstimate` for usage-based billing,
 *   - the call lands in the in-memory `sessionTracker` ledger,
 *   - the wire payload uses compact `JSON.stringify` (≈ 30 % cheaper than indent).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { correlationIdFromMeta } from './correlation.js';
import { toMcpInputSchema } from './json-schema.js';
import { compactJson } from './llm-optimize.js';
import { createLogger, type Logger } from './log.js';
import type { PromptDefinition } from './prompt.js';
import { buildMeta, wrapResponse, type ToolResponse } from './response-meta.js';
import { sessionTracker } from './session-tracker.js';
import { getRepoVersion } from './version.js';

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  readonly correlationId: string;
  readonly server: string;
  readonly version: string;
  readonly tool: string;
  readonly logger: Logger;
}

/**
 * Optional shape a handler can return to signal upstream truncation. The
 * factory peels off the marker and surfaces it on `_meta.truncated`; callers
 * never see the marker in their data payload.
 */
export interface TruncatedResult<T> {
  readonly __truncated: true;
  readonly data: T;
}

export function markTruncated<T>(data: T): TruncatedResult<T> {
  return { __truncated: true, data };
}

function isTruncatedMarker(value: unknown): value is TruncatedResult<unknown> {
  return typeof value === 'object' && value !== null && (value as { __truncated?: unknown }).__truncated === true;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodSchema;
  readonly handle: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Helper that preserves the schema's inferred type in the handler signature.
 * Use it instead of a bare object literal so destructured args (`{key, fields}`)
 * pick up the right types from the Zod schema.
 */
export function defineTool<I extends z.ZodSchema>(t: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: I;
  readonly handle: (input: z.infer<I>, ctx: ToolContext) => Promise<unknown>;
}): ToolDefinition {
  return t as unknown as ToolDefinition;
}

export interface StartOptions {
  readonly name: string;
  readonly tools: readonly ToolDefinition[];
  /**
   * Preconfigured prompts surfaced via MCP `prompts/list` + `prompts/get`.
   * Copilot Chat shows them as slash-commands (`/<server>.<prompt>`) — caller
   * doesn't have to compose JQL / CQL queries from scratch every time.
   *
   * Pass `[]` jawnie jeśli serwer nie ma promptów (rare).
   */
  readonly prompts: readonly PromptDefinition[];
}

/**
 * Boot helper który respektuje `MCP_NO_BOOT=true` (escape hatch dla doc
 * generatora importującego serwer bez uruchamiania stdio transportu).
 *
 * Każdy `server-*.ts` kończy plik dwoma liniami:
 * ```ts
 * export { tools };
 * await bootMcpServerIfEnabled({ name: SERVER_NAME, tools });
 * ```
 *
 * Magic env-var name (`MCP_NO_BOOT`) żyje tylko w tym pliku — gdy będziemy go
 * zmieniać, jest jedno miejsce do update'u.
 */
export async function bootMcpServerIfEnabled(options: StartOptions): Promise<void> {
  if (process.env['MCP_NO_BOOT']) return;
  await startMcpServer(options);
}

/**
 * Factory dla `<server>.get_usage_history` tool — identycznej powierzchni w
 * każdym serwerze. Zamiast 5× duplikować defineTool block, każdy server
 * wystawia: `tools.push(usageHistoryTool(SERVER_NAME))`.
 *
 * Zwraca in-memory `sessionTracker.getSummary()` — ostatnie wywołania w
 * bieżącej sesji procesu. Patrz `docs/explanation/observability.md`.
 */
export function usageHistoryTool(serverName: string): ToolDefinition {
  const prefix = serverName.startsWith('mcp-') ? serverName.slice('mcp-'.length) : serverName;
  return defineTool({
    name: `${prefix}.get_usage_history`,
    description:
      'Return this server-instance session ledger: every tool call so far with input/output chars, token estimate, latency, ok/error. In-memory only — resets on restart.',
    inputSchema: z.object({}),
    async handle() {
      return sessionTracker.getSummary();
    },
  });
}

/** Boot the MCP server, register handlers, attach stdio transport, return when wired. */
export async function startMcpServer(options: StartOptions): Promise<void> {
  const version = getRepoVersion();
  const logger = createLogger({ server: options.name, version });
  const byName = new Map(options.tools.map((t) => [t.name, t]));

  const server = new Server({ name: options.name, version }, { capabilities: { tools: {}, prompts: {} } });
  const promptsByName = new Map(options.prompts.map((p) => [p.name, p]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toMcpInputSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: options.prompts.map((p) => ({
      name: p.name,
      description: p.description,
      ...(p.arguments
        ? {
            arguments: p.arguments.map((a) => ({
              name: a.name,
              description: a.description,
              required: a.required ?? false,
            })),
          }
        : {}),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = promptsByName.get(req.params.name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${req.params.name}`);
    }
    const args: Record<string, string> = req.params.arguments ?? {};
    return {
      description: prompt.description,
      messages: prompt.buildMessages(args),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }

    const correlationId = correlationIdFromMeta(req.params._meta);
    const ctx: ToolContext = { correlationId, server: options.name, version, tool: tool.name, logger };
    const start = Date.now();
    const input = req.params.arguments;
    const envelope = await runHandler(tool, ctx, input, start);

    return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
  });

  // AC60 — graceful shutdown na SIGTERM / SIGINT. Flush session summary do stderr,
  // pozwól MCP SDK transport zamknąć stdio czysto, hard exit po 5s jeśli pending io.
  registerShutdownHandlers(options.name, logger);

  await server.connect(new StdioServerTransport());
  logger.log({ ok: true, msg: `started, ${options.tools.length} tools` });
}

/**
 * AC60: Graceful shutdown handler. Wywoływany przy SIGTERM (kontener stop) lub
 * SIGINT (Ctrl-C). Zrzuca `sessionTracker.getSummary()` na stderr (nie stdout
 * — stdout to MCP protokół), daje stdio chwilę na flush, exit 0.
 *
 * Hard timeout 5s gwarantuje że proces nie wisi w nieskończoność na await'ujących
 * fetch'ach — w razie czego exit 137 (SIGKILL semantics).
 */
function registerShutdownHandlers(serverName: string, logger: Logger): void {
  let shuttingDown = false;
  const HARD_EXIT_MS = 5000;

  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return; // idempotent — kolejny sygnał nie restartuje cleanup
    shuttingDown = true;

    const summary = sessionTracker.getSummary();
    process.stderr.write(
      `\n[${serverName}] shutdown on ${signal}: ${summary.totalCalls} calls, ${summary.totalTokens} tokens estimated\n`,
    );
    logger.log({ ok: true, msg: `shutting down on ${signal}` });

    // Hard exit fallback — daje 5s na flush stdio i async cleanup; potem 137.
    const timer = setTimeout(() => {
      process.stderr.write(`[${serverName}] hard exit after ${HARD_EXIT_MS}ms\n`);
      process.exit(137);
    }, HARD_EXIT_MS);
    timer.unref(); // nie blokuj event loopa jeśli inne pending taski się czysto zakończą

    // Graceful: zostaw chwilę dla stdio flush, potem normal exit.
    setImmediate(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

/**
 * Validate → handle → unwrap truncation marker → wrap in `{ data, _meta }` →
 * register the call in `sessionTracker`. Failures still produce a `_meta`-rich
 * envelope and re-throw the original error after recording.
 */
async function runHandler(
  tool: ToolDefinition,
  ctx: ToolContext,
  input: unknown,
  start: number,
): Promise<ToolResponse> {
  try {
    const parsed = tool.inputSchema.parse(input);
    const raw = await tool.handle(parsed, ctx);
    const truncated = isTruncatedMarker(raw);
    const unwrapped = truncated ? raw.data : raw;
    // Strip nulls / empty arrays / empty strings before billing — drops 10-25 %
    // off the wire JSON without losing signal. Booleans stay because `false` is
    // a meaningful state ("draft: false", "isLast: false").
    const data = compactJson(unwrapped);
    const durationMs = Date.now() - start;
    const rateLimit = sessionTracker.takeRateLimit(ctx.correlationId);
    const meta = buildMeta(data, {
      correlationId: ctx.correlationId,
      server: ctx.server,
      tool: ctx.tool,
      durationMs,
      ...(truncated ? { truncated: true } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    });
    sessionTracker.record({
      server: ctx.server,
      tool: ctx.tool,
      correlationId: ctx.correlationId,
      inputChars: stringifyLength(input),
      outputChars: stringifyLength(data),
      tokensEstimate: meta.tokensEstimate,
      durationMs,
      ok: true,
    });
    ctx.logger.log({ tool: ctx.tool, correlationId: ctx.correlationId, durationMs, ok: true });
    return wrapResponse(data, meta);
  } catch (error_: unknown) {
    const durationMs = Date.now() - start;
    const error = error_ instanceof Error ? error_.message : String(error_);
    sessionTracker.record({
      server: ctx.server,
      tool: ctx.tool,
      correlationId: ctx.correlationId,
      inputChars: stringifyLength(input),
      outputChars: 0,
      tokensEstimate: 0,
      durationMs,
      ok: false,
      error,
    });
    ctx.logger.log({ tool: ctx.tool, correlationId: ctx.correlationId, durationMs, ok: false, error });
    throw error_;
  }
}

function stringifyLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}
