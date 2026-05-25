/**
 * Token loading. One discriminated union per tool — never read env vars or
 * config files elsewhere in the codebase. See `.github/instructions/tokens.instructions.md` §1–§2 and
 * `docs/explanation/security-architecture.md` for the storage policy.
 *
 * Resolution priority:
 *   1. Process environment variable (highest — wins for CI / containers).
 *   2. User-profile config file (`~/.config/mcp-alm/config.json`).
 *   3. Throw `AuthError` — never default a token silently.
 */
import { AuthError } from './errors.js';
import { loadUserConfig, type UserConfig } from './user-config.js';

interface JiraAuth {
  readonly tool: 'jira';
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
}

interface ConfluenceAuth {
  readonly tool: 'confluence';
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
}

interface FigmaAuth {
  readonly tool: 'figma';
  readonly baseUrl: string;
  readonly token: string;
}

interface SonarAuth {
  readonly tool: 'sonar';
  readonly baseUrl: string;
  readonly token: string;
}

interface GitLabAuth {
  readonly tool: 'gitlab';
  readonly baseUrl: string;
  readonly token: string;
}

export type AuthConfig = JiraAuth | ConfluenceAuth | FigmaAuth | SonarAuth | GitLabAuth;

/** Cache the user-config read for a single Node process (file lookups are cheap but not free). */
let cached: UserConfig | undefined;
function userConfig(): UserConfig {
  cached ??= loadUserConfig();
  return cached;
}

function fromEnvironment(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function fromUserConfig<Section extends keyof UserConfig>(
  section: Section,
  key: keyof NonNullable<UserConfig[Section]>,
): string | undefined {
  const block = userConfig()[section];
  if (!block) return undefined;
  const value = (block as Record<string, unknown>)[key as string];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Resolve a required string from env first, user-profile config second; throw
 * `AuthError` otherwise. Renamed from `require` to avoid shadowing the
 * CommonJS built-in (this repo is ESM, but linters and humans both prefer
 * non-shadowing).
 */
function requireSecret<Section extends keyof UserConfig>(
  envVariable: string,
  section: Section,
  key: keyof NonNullable<UserConfig[Section]>,
  tool: string,
): string {
  const value = fromEnvironment(envVariable) ?? fromUserConfig(section, key);
  if (!value) {
    throw new AuthError(
      `Missing ${tool} secret: set env ${envVariable} OR add ${section as string}.${key as string} to ` +
        `the user-profile config (see docs/explanation/security-architecture.md §"Token storage" for the path on your OS).`,
      tool,
    );
  }
  return value;
}

function optional<Section extends keyof UserConfig>(
  envVariable: string,
  section: Section,
  key: keyof NonNullable<UserConfig[Section]>,
  fallback: string,
): string {
  return fromEnvironment(envVariable) ?? fromUserConfig(section, key) ?? fallback;
}

export function loadJiraAuth(): JiraAuth {
  return {
    tool: 'jira',
    baseUrl: requireSecret('JIRA_BASE_URL', 'jira', 'baseUrl', 'jira'),
    email: requireSecret('JIRA_EMAIL', 'jira', 'email', 'jira'),
    token: requireSecret('JIRA_TOKEN', 'jira', 'token', 'jira'),
  };
}

export function loadConfluenceAuth(): ConfluenceAuth {
  return {
    tool: 'confluence',
    baseUrl: requireSecret('CONFLUENCE_BASE_URL', 'confluence', 'baseUrl', 'confluence'),
    email: requireSecret('CONFLUENCE_EMAIL', 'confluence', 'email', 'confluence'),
    token: requireSecret('CONFLUENCE_TOKEN', 'confluence', 'token', 'confluence'),
  };
}

export function loadFigmaAuth(): FigmaAuth {
  return {
    tool: 'figma',
    baseUrl: optional('FIGMA_BASE_URL', 'figma', 'baseUrl', 'https://api.figma.com'),
    token: requireSecret('FIGMA_TOKEN', 'figma', 'token', 'figma'),
  };
}

export function loadSonarAuth(): SonarAuth {
  return {
    tool: 'sonar',
    baseUrl: requireSecret('SONAR_BASE_URL', 'sonar', 'baseUrl', 'sonar'),
    token: requireSecret('SONAR_TOKEN', 'sonar', 'token', 'sonar'),
  };
}

export function loadGitLabAuth(): GitLabAuth {
  return {
    tool: 'gitlab',
    baseUrl: optional('GITLAB_BASE_URL', 'gitlab', 'baseUrl', 'https://gitlab.com/api/v4'),
    token: requireSecret('GITLAB_TOKEN', 'gitlab', 'token', 'gitlab'),
  };
}
