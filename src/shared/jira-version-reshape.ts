/**
 * Reshape a raw Jira project version (`/rest/api/3/project/{key}/version`) into
 * a token-friendly canonical release. Drops `self`, `projectId`, `userReleaseDate`
 * and other UI noise; keeps the fields a planning agent reasons about — name,
 * the two boolean states (`released` / `archived`), the dates and the goal-ish
 * `description`. `overdue` is surfaced only when upstream reports it.
 *
 * Pure function — unit-tested in `jira-version-reshape.spec.ts`; the
 * `jira.list_versions` tool wires it to HTTP. Booleans are always emitted
 * (`released: false` is a meaningful state the LLM needs).
 */

export interface CanonicalVersion {
  readonly id: string;
  readonly name: string;
  readonly released: boolean;
  readonly archived: boolean;
  readonly description?: string;
  readonly releaseDate?: string;
  readonly startDate?: string;
  readonly overdue?: boolean;
}

interface RawVersion {
  readonly id?: string;
  readonly name?: string;
  readonly released?: boolean;
  readonly archived?: boolean;
  readonly description?: string;
  readonly releaseDate?: string;
  readonly startDate?: string;
  readonly overdue?: boolean;
}

/** Keep a string only when present and not blank — otherwise drop the key. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

export function reshapeVersion(raw: RawVersion): CanonicalVersion {
  const description = nonEmpty(raw.description);
  const releaseDate = nonEmpty(raw.releaseDate);
  const startDate = nonEmpty(raw.startDate);
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    released: raw.released ?? false,
    archived: raw.archived ?? false,
    ...(description ? { description } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...(startDate ? { startDate } : {}),
    ...(raw.overdue !== undefined ? { overdue: raw.overdue } : {}),
  };
}
