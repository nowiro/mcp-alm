/**
 * Cross-platform user-profile config loader for sensitive ALM credentials.
 *
 * Path resolution (matches XDG Base Directory spec where applicable):
 * - $MCP_ALM_CONFIG_DIR/config.json (highest, lets tests + ops override the whole path)
 * - $XDG_CONFIG_HOME/mcp-alm/config.json (Linux-conventional, set in some shells)
 * - <home>/.config/mcp-alm/config.json (default — works on Windows / macOS / Linux)
 *
 * Where `<home>` is `os.homedir()` — Node returns:
 * - `%USERPROFILE%` on Windows (e.g. `C:\Users\<you>`)
 * - `$HOME` on macOS / Linux (e.g. `/Users/<you>`, `/home/<you>`)
 *
 * Token resolution priority (read by `auth.ts`):
 * 1. Process environment variable (e.g. `JIRA_TOKEN`) — wins for CI / containers / shell exports.
 * 2. The user-profile config file (this loader).
 * 3. Throw `AuthError` — never default tokens silently.
 *
 * Security invariants:
 * - The file is read at the time it is needed, not eagerly at module load.
 * - On POSIX, a file mode looser than `0600` emits a stderr warning.
 * - Token values never appear in log lines, errors, or stack traces.
 * - Repo files NEVER contain real tokens. `config.example.json` ships with placeholders only.
 * @see docs/explanation/security-architecture.md — full token storage policy.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Leaf folder under `~/.config/` — derived from `package.json#name` at module load
 * so that downstream forks (e.g. `mcp-acme-alm`) automatically get their own
 * config directory without touching this file.
 *
 * Resolution order:
 *   1. `$MCP_ALM_REPO_SLUG` env (operator override, useful for tests / migration)
 *   2. `package.json#name` (npm scope stripped) discovered by walking up from this file
 *   3. literal `'mcp-alm'` as last-resort fallback
 */
function resolveRepoSlug(): string {
  const override = process.env['MCP_ALM_REPO_SLUG']?.trim();
  if (override) return override;

  try {
    // `import.meta.url` works in both src/ (tsx) and dist/ (compiled ESM).
    const here = nodePath.dirname(fileURLToPath(import.meta.url));
    // Walk up until we find package.json (handles src/shared/, dist/shared/, dist/cjs/shared/, …).
    let directory = here;
    for (let i = 0; i < 6; i += 1) {
      const candidate = nodePath.join(directory, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (pkg.name && typeof pkg.name === 'string') {
          // Strip npm scope so "@nowiro/mcp-alm" → "mcp-alm" (fork-safe; unscoped names unchanged).
          return pkg.name.replace(/^@[^/]+\//, '');
        }
        break;
      }
      const parent = nodePath.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // best-effort — fall through to literal
  }
  return 'mcp-alm';
}

const REPO_SLUG = resolveRepoSlug();

/**
 * Zod schema for the user-profile config file. Every section is optional —
 * a deployment may bind only the connectors it actually needs.
 *
 * Field naming matches the env-var convention: drop the `JIRA_` prefix and
 * lowercase. e.g. `JIRA_BASE_URL` ↔ `jira.baseUrl`.
 */
export const UserConfigSchema = z
  .object({
    jira: z
      .object({
        baseUrl: z.string().url().optional(),
        email: z.string().email().optional(),
        token: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    confluence: z
      .object({
        baseUrl: z.string().url().optional(),
        email: z.string().email().optional(),
        token: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    figma: z
      .object({
        baseUrl: z.string().url().optional(),
        token: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    sonar: z
      .object({
        baseUrl: z.string().url().optional(),
        token: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    gitlab: z
      .object({
        baseUrl: z.string().url().optional(),
        token: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UserConfig = z.infer<typeof UserConfigSchema>;

/**
 * Resolve the absolute path of the user-profile config file.
 * Pure — does not touch the filesystem.
 *
 * Priority:
 *   1. `$MCP_ALM_CONFIG_DIR/config.json`              (full override, used by tests)
 *   2. `$XDG_CONFIG_HOME/<REPO_SLUG>/config.json`     (XDG-conformant, Linux)
 *   3. `<home>/.config/<REPO_SLUG>/config.json`       (default, cross-platform)
 *
 * `<REPO_SLUG>` derived from `package.json#name` (see `resolveRepoSlug`).
 * On Windows `homedir()` returns `%USERPROFILE%` (e.g. `C:\Users\you`); on
 * macOS / Linux it returns `$HOME`. Forward + backslashes are normalised
 * by `nodePath.join`.
 */
export function getUserConfigPath(): string {
  const override = process.env['MCP_ALM_CONFIG_DIR']?.trim();
  if (override) return nodePath.resolve(override, 'config.json');

  const xdg = process.env['XDG_CONFIG_HOME']?.trim();
  if (xdg) return nodePath.resolve(xdg, REPO_SLUG, 'config.json');

  return nodePath.join(homedir(), '.config', REPO_SLUG, 'config.json');
}

/** Optional permission warning on POSIX systems (no-op on Windows). */
function warnIfWorldReadable(path: string): void {
  if (platform() === 'win32') return;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(
        `[user-config] warn: ${path} is mode ${mode.toString(8)}; recommend 0600 (chmod 600 "${path}")\n`,
      );
    }
  } catch {
    // best-effort — not fatal
  }
}

/**
 * Load and validate the user-profile config from disk. Returns an empty object
 * if the file is absent so callers can transparently fall back to env vars.
 *
 * Throws `Error` (not `AuthError` — that lives in `auth.ts`) if the file exists
 * but fails JSON parsing or schema validation. The caller must distinguish
 * "missing" (= fall back to env) from "malformed" (= hard fail).
 */
export function loadUserConfig(): UserConfig {
  const path = getUserConfigPath();
  if (!existsSync(path)) return {};

  warnIfWorldReadable(path);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`user-config: failed to read ${path}: ${message}`, { cause: error });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`user-config: ${path} is not valid JSON`);
  }

  // JSON has no native comments; we let users keep documentation strings at
  // the top level as `$comment`, `$copy_to_windows`, etc. Strip every `$`-
  // prefixed key before schema validation so the strict object keeps biting
  // on real typos.
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    json = Object.fromEntries(Object.entries(json as Record<string, unknown>).filter(([key]) => !key.startsWith('$')));
  }

  const parsed = UserConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`user-config: ${path} failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
