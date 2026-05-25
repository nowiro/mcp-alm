/**
 * JQL filter compiler — type-safe, composable filter builder for Jira Query
 * Language. Lets agents construct queries via a discriminated union instead of
 * hand-rolling JQL strings (which are easy to get subtly wrong: missing quotes,
 * unescaped special chars, unbalanced parentheses).
 *
 * Pure module — no I/O, no upstream calls. Imported by `server-jira.ts` for
 * the `jira.jql_builder` tool and reusable by anything that wants to author
 * JQL programmatically.
 *
 * Design rules:
 *   - Values are always escaped before being interpolated.
 *   - Composite filters (`and`, `or`, `not`) wrap their child expression in
 *     parentheses to preserve precedence regardless of nesting order.
 *   - Recursion is capped at `MAX_DEPTH` (10) to bound input cost.
 *   - The `raw` escape hatch surfaces lint warnings (unbalanced quotes /
 *     parens) on the `errors` channel without rejecting the query — the
 *     caller decides whether to ship it.
 */
import { z } from 'zod';

/** Maximum allowed nesting depth for composite filters. */
export const MAX_DEPTH = 10;

// ── public types ────────────────────────────────────────────────────────────

export type JqlFilter =
  | { readonly kind: 'project'; readonly key: string }
  | { readonly kind: 'status'; readonly status: string }
  | { readonly kind: 'assignee'; readonly user: string }
  | { readonly kind: 'updated_since'; readonly days: number }
  | { readonly kind: 'and'; readonly filters: readonly JqlFilter[] }
  | { readonly kind: 'or'; readonly filters: readonly JqlFilter[] }
  | { readonly kind: 'not'; readonly filter: JqlFilter }
  | { readonly kind: 'raw'; readonly jql: string };

export interface CompileResult {
  readonly jql: string;
  readonly valid: boolean;
  readonly errors: readonly string[];
}

// ── zod schema (recursive via z.lazy) ───────────────────────────────────────

/**
 * Recursive Zod schema for `JqlFilter`. Declared with `z.lazy` so the union
 * can reference itself in the `and` / `or` / `not` branches. The inferred
 * type is asserted to keep TypeScript and Zod's inference in lockstep.
 */
export const JqlFilterSchema: z.ZodType<JqlFilter> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('project'), key: z.string().min(1) }),
    z.object({ kind: z.literal('status'), status: z.string().min(1) }),
    z.object({ kind: z.literal('assignee'), user: z.string().min(1) }),
    z.object({ kind: z.literal('updated_since'), days: z.number().int().min(0).max(3650) }),
    z.object({ kind: z.literal('and'), filters: z.array(JqlFilterSchema).min(1) }),
    z.object({ kind: z.literal('or'), filters: z.array(JqlFilterSchema).min(1) }),
    z.object({ kind: z.literal('not'), filter: JqlFilterSchema }),
    z.object({ kind: z.literal('raw'), jql: z.string().min(1) }),
  ]),
);

// ── compile ─────────────────────────────────────────────────────────────────

/**
 * Compile a filter tree to a JQL string with validation diagnostics.
 * @param filter - root filter node
 * @returns `{ jql, valid, errors }`
 *   - `jql`     — best-effort string even when warnings fire
 *   - `valid`   — `true` iff `errors` is empty
 *   - `errors`  — human-readable warnings (depth, raw-syntax, empty groups)
 */
export function compileJqlFilter(filter: JqlFilter): CompileResult {
  const errors: string[] = [];
  const jql = render(filter, 0, errors);
  return { jql, valid: errors.length === 0, errors };
}

// ── internals ───────────────────────────────────────────────────────────────

function renderComposite(kind: 'and' | 'or', filters: readonly JqlFilter[], depth: number, errors: string[]): string {
  if (filters.length === 0) {
    errors.push(`Empty '${kind}' filter group.`);
    return '';
  }
  const op = kind === 'and' ? 'AND' : 'OR';
  const parts = filters.map((f) => render(f, depth + 1, errors)).filter((s) => s.length > 0);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] ?? '';
  const joiner = ` ${op} `;
  return `(${parts.join(joiner)})`;
}

/**
 * Recursive renderer. Pushes diagnostics into `errors`; never throws on
 * caller-supplied content (so a partial JQL is still surfaced to the agent).
 */
function render(filter: JqlFilter, depth: number, errors: string[]): string {
  if (depth > MAX_DEPTH) {
    errors.push(`Filter nesting exceeds max depth of ${MAX_DEPTH}.`);
    return '';
  }

  switch (filter.kind) {
    case 'project': {
      return `project = ${quote(filter.key)}`;
    }

    case 'status': {
      return `status = ${quote(filter.status)}`;
    }

    case 'assignee': {
      // `currentUser()` is a JQL function call — preserve it verbatim.
      return filter.user === 'currentUser()' ? 'assignee = currentUser()' : `assignee = ${quote(filter.user)}`;
    }

    case 'updated_since': {
      return `updated >= -${filter.days}d`;
    }

    case 'and':
    case 'or': {
      return renderComposite(filter.kind, filter.filters, depth, errors);
    }

    case 'not': {
      const inner = render(filter.filter, depth + 1, errors);
      return inner.length === 0 ? '' : `NOT (${inner})`;
    }

    case 'raw': {
      const raw = filter.jql.trim();
      if (raw.length === 0) {
        errors.push('Raw JQL is empty.');
        return '';
      }
      const lintErrors = lintRawJql(raw);
      for (const err of lintErrors) errors.push(err);
      return raw;
    }
  }
}

/**
 * Wrap a value in double quotes, escaping embedded `\` and `"`. Matches the
 * Jira docs for "Reserved characters in field values" — backslash is the
 * escape character; only backslash and the surrounding quote need escaping
 * inside a quoted string.
 */
export function quote(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`);
  return `"${escaped}"`;
}

/**
 * Lightweight JQL linter for the `raw` escape hatch. Checks balanced quotes
 * and parentheses — full grammar validation would duplicate Atlassian's
 * upstream parser, so we keep this to the two highest-signal symptoms.
 */
export function lintRawJql(jql: string): string[] {
  const errors: string[] = [];
  if (!quotesBalanced(jql)) errors.push('Raw JQL has unbalanced double quotes.');
  if (!parensBalanced(jql)) errors.push('Raw JQL has unbalanced parentheses.');
  return errors;
}

/** True iff every unescaped `"` is paired. */
function quotesBalanced(jql: string): boolean {
  let open = false;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (ch === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (ch === '"') open = !open;
  }
  return !open;
}

/** True iff `(` and `)` are paired and never close before open. */
function parensBalanced(jql: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (ch === '\\' && inString) {
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}
