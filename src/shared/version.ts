/**
 * Read this repo's version from `package.json` once and cache it. Used by the
 * MCP server name/version handshake, by every log line, and by the outbound
 * `User-Agent` header so upstream rate limits / audit logs can attribute calls.
 *
 * Resolves `package.json` relative to this file (works for both `src/` during
 * dev and `dist/` after build — `dist/shared/version.js` is two levels deep).
 */
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK = '0.0.0';
let cached: string | undefined;

export function getRepoVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const here = nodePath.dirname(fileURLToPath(import.meta.url));
    const packagePath = nodePath.resolve(here, '..', '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    cached = typeof packageJson.version === 'string' && packageJson.version.length > 0 ? packageJson.version : FALLBACK;
  } catch {
    cached = FALLBACK;
  }
  return cached;
}
