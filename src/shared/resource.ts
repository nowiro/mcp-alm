/**
 * Resource registry — natywny MCP feature `resources/list` + `resources/read`.
 *
 * Resources to read-only docs / configs / samples które Copilot Chat
 * może załadować deterministically jako kontekst (zamiast pytać "jak
 * skomponować JQL", server odsłania `mcp-jira://docs/jql-cheatsheet`).
 *
 * Token saving:
 *   - cached przez Copilot — załaduj raz, użyj wielokrotnie;
 *   - deterministic content — żadnego LLM round-trip żeby "wyjaśnić";
 *   - structured URIs (`<server>://docs/<topic>`) ułatwiają discovery.
 *
 * @see src/shared/mcp-server.ts — startMcpServer registers handlers
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface ResourceDefinition {
  /** URI in format `<server>://<category>/<slug>` (e.g. `mcp-jira://docs/jql-cheatsheet`). */
  readonly uri: string;
  /** Display name in Copilot resource picker. */
  readonly name: string;
  /** One-liner — pokazuje się obok name. */
  readonly description: string;
  /** MIME type. Default `text/markdown` dla docs. */
  readonly mimeType: string;
  /** Async (read from fs) lub sync (inline string). Returns full content. */
  readonly read: () => Promise<string> | string;
}

/** Constructor preserving readonly contracts. */
export function defineResource(r: ResourceDefinition): ResourceDefinition {
  return r;
}

/**
 * Helper for `templates/resources/<file>.md` markdown docs. Resolves the path
 * relative to the compiled `dist/` location (via `import.meta.url`), so the
 * server works regardless of caller's `cwd` (`npx mcp-jira` from anywhere).
 *
 * @example
 *   defineMarkdownResource({
 *     uri: 'mcp-jira://docs/jql-cheatsheet',
 *     name: 'JQL cheatsheet',
 *     description: 'Field names, operators, common JQL patterns.',
 *     file: 'jira-jql-cheatsheet.md',
 *   })
 */
export function defineMarkdownResource(spec: {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly file: string;
}): ResourceDefinition {
  return {
    uri: spec.uri,
    name: spec.name,
    description: spec.description,
    mimeType: 'text/markdown',
    read: async () => {
      const url = new URL(`../../templates/resources/${spec.file}`, import.meta.url);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- file slug is a hard-coded literal from caller
      return readFile(fileURLToPath(url), 'utf8');
    },
  };
}
