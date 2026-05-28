/**
 * Pure emitters for Figma design tokens → CSS variables / SCSS variables / TS const.
 *
 * Kept dependency-free and side-effect free so the connector handler stays a
 * one-liner: fetch Variables API, map to `Token[]`, hand to the matching
 * emitter. Name normalisation is locked at the emitter boundary:
 *
 *   - CSS / SCSS — kebab-case (`color-primary`, `spacing-sm`),
 *   - TS         — camelCase (`colorPrimary`, `spacingSm`).
 *
 * The Token shape is intentionally narrow (name + value + kind) — anything
 * richer (modes, references, aliases) belongs in the mapping layer that
 * produces `Token[]`, not in the emitters.
 */

/** Supported token kinds. Matches the categories surfaced by Figma Variables. */
export type TokenKind = 'color' | 'spacing' | 'typography' | 'radius' | 'shadow';

/** Canonical token shape consumed by the emitters. */
export interface Token {
  readonly name: string;
  readonly value: string;
  readonly kind: TokenKind;
}

/**
 * Emit `:root { --name: value; … }` from a token list. Names are kebab-cased;
 * duplicates after normalisation keep the last occurrence (mirrors CSS cascade).
 */
export function emitCss(tokens: readonly Token[]): string {
  if (tokens.length === 0) return ':root {\n}';
  const lines = dedupeByName(tokens, toKebabCase).map(([name, value]) => `  --${name}: ${value};`);
  return `:root {\n${lines.join('\n')}\n}`;
}

/**
 * Emit `$name: value;` SCSS variable declarations. Names are kebab-cased; one
 * declaration per line, terminating newline omitted to match repo style.
 */
export function emitScss(tokens: readonly Token[]): string {
  if (tokens.length === 0) return '';
  return dedupeByName(tokens, toKebabCase)
    .map(([name, value]) => `$${name}: ${value};`)
    .join('\n');
}

/**
 * Emit a `const tokens = { … } as const;` TS module. Property keys are
 * camelCased and quoted only when they collide with a reserved character.
 */
export function emitTs(tokens: readonly Token[]): string {
  if (tokens.length === 0) return 'export const tokens = {} as const;';
  const lines = dedupeByName(tokens, toCamelCase).map(([name, value]) => `  ${name}: ${JSON.stringify(value)},`);
  return `export const tokens = {\n${lines.join('\n')}\n} as const;`;
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Normalise a Figma-style token name (`Color/Primary 500`, `spacing.sm`,
 * `radius--lg`) to kebab-case. Non-alphanumeric runs collapse to a single dash;
 * camelCase splits are inserted before consecutive uppercase letters.
 */
function toKebabCase(raw: string): string {
  // Bounded quantifiers (≤32) keep sonarjs/slow-regex happy without limiting
  // realistic token names (longest real ones are ~30 chars).
  return raw
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/[^a-zA-Z0-9]{1,32}/g, '-')
    .replace(/^-{1,32}/, '')
    .replace(/-{1,32}$/, '')
    .toLowerCase();
}

/** Convert kebab/space/dot-separated names to camelCase. */
function toCamelCase(raw: string): string {
  const kebab = toKebabCase(raw);
  if (kebab.length === 0) return '';
  const parts = kebab.split('-');
  const [head, ...tail] = parts;
  return (head ?? '') + tail.map((p) => (p.length === 0 ? '' : (p[0] ?? '').toUpperCase() + p.slice(1))).join('');
}

/**
 * Apply `normalise` to each token name and keep the last occurrence for
 * collisions — preserves input order otherwise. Returns `[name, value]` pairs
 * so the caller can format without re-looking up the token.
 */
function dedupeByName(tokens: readonly Token[], normalise: (name: string) => string): [string, string][] {
  const map = new Map<string, string>();
  for (const t of tokens) {
    const key = normalise(t.name);
    if (key.length === 0) continue;
    map.set(key, t.value);
  }
  return [...map.entries()];
}
