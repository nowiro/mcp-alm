/**
 * Convert a Zod schema to a JSON Schema object suitable for MCP `tools/list`
 * `inputSchema`. Zod v4 ships `toJSONSchema` natively, so no extra dep.
 *
 * MCP clients (Claude Desktop, Cursor, Copilot) expect a bare JSON Schema —
 * we strip the `$schema` meta key the generator emits by default.
 */
import { z } from 'zod';

export function toMcpInputSchema(schema: z.ZodSchema): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete out['$schema'];
  return out;
}
