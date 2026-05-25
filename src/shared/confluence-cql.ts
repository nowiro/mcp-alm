/**
 * Pure helpers for assembling Confluence CQL (Confluence Query Language)
 * search strings.
 *
 * Why this is split out from `server-confluence.ts`:
 *   - CQL string assembly is deterministic and worth unit-testing without
 *     spinning up the HTTP client.
 *   - Escaping `"` in user-provided labels / space keys is the only thing
 *     standing between us and a malformed query (or, in adversarial input,
 *     a CQL-injection); a pure function makes that property easy to assert.
 *
 * CQL reference: https://developer.atlassian.com/server/confluence/advanced-searching-using-cql/
 *   - Quoted string literals use `"…"`; embedded `"` must be backslash-escaped.
 *   - `label in ("a","b")` matches any of the listed labels (OR semantics).
 *   - `space.key = "X"` constrains to a single space.
 */

/** Escape a CQL quoted-string literal value. Backslash and `"` are the only specials. */
export function escapeCqlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`);
}

export interface BuildLabelCqlInput {
  readonly labels: readonly string[];
  readonly space?: string;
}

/**
 * Build the CQL string for "pages tagged with any of these labels, optionally
 * scoped to a single space".
 *
 * Example output:
 *   labels: ["bug", "infra"], space: "ENG"
 *   → `label in ("bug","infra") AND space.key = "ENG" AND type = "page"`
 */
export function buildLabelSearchCql(input: BuildLabelCqlInput): string {
  const labels = input.labels.map((l) => l.trim()).filter((l) => l.length > 0);
  if (labels.length === 0) {
    throw new Error('buildLabelSearchCql: at least one non-empty label is required');
  }

  const labelList = labels.map((l) => `"${escapeCqlString(l)}"`).join(',');
  const parts: string[] = [`label in (${labelList})`];

  const space = input.space?.trim();
  if (space && space.length > 0) {
    parts.push(`space.key = "${escapeCqlString(space)}"`);
  }

  parts.push('type = "page"');
  return parts.join(' AND ');
}
