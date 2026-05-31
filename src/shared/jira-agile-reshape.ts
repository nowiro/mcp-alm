/**
 * Reshape raw Jira Agile (`/rest/agile/1.0/`) board + sprint payloads into
 * token-friendly canonical shapes.
 *
 * The agile API carries UI noise the LLM never needs: `self` links, avatar
 * URIs, `projectTypeKey`, the nested board `location` block. We flatten the one
 * thing an agent actually wants off a board (its owning project) and keep only
 * the sprint fields that describe scope + timeline (`state`, the three dates,
 * `goal`). `originBoardId` is renamed to the friendlier `boardId`.
 *
 * Pure functions — no upstream calls, no field registry. Unit-tested in
 * `jira-agile-reshape.spec.ts`; the `server-jira` tools wire them to HTTP.
 * Mirrors the `jira-reshape` / `gitlab-reshape` split: shared reshape = the
 * tested unit, the server file is thin wiring.
 */

export interface CanonicalBoard {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly projectKey?: string;
  readonly projectName?: string;
}

export interface CanonicalSprint {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly completeDate?: string;
  readonly goal?: string;
  readonly boardId?: number;
}

export interface CanonicalBoardColumn {
  readonly name: string;
  readonly statusIds: readonly string[];
}

export interface CanonicalBoardConfig {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  /** Field the board estimates with — e.g. `{ id: 'customfield_10016', name: 'Story Points' }`. */
  readonly estimationField?: { readonly id: string; readonly name: string };
  readonly columns: readonly CanonicalBoardColumn[];
}

interface RawBoardLocation {
  readonly projectKey?: string;
  readonly projectName?: string;
}

interface RawBoard {
  readonly id?: number;
  readonly name?: string;
  readonly type?: string;
  readonly location?: RawBoardLocation;
}

interface RawSprint {
  readonly id?: number;
  readonly name?: string;
  readonly state?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly completeDate?: string;
  readonly originBoardId?: number;
  readonly goal?: string;
}

interface RawBoardColumn {
  readonly name?: string;
  readonly statuses?: readonly { readonly id?: string }[];
}

interface RawBoardConfig {
  readonly id?: number;
  readonly name?: string;
  readonly type?: string;
  readonly columnConfig?: { readonly columns?: readonly RawBoardColumn[] };
  readonly estimation?: { readonly field?: { readonly fieldId?: string; readonly displayName?: string } };
}

/** Keep a string only when it is present and not blank — otherwise drop the key. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * Flatten a raw agile board to `{ id, name, type, projectKey?, projectName? }`.
 * The `location` nesting and every avatar / type-key field are dropped.
 */
export function reshapeBoard(raw: RawBoard): CanonicalBoard {
  const projectKey = nonEmpty(raw.location?.projectKey);
  const projectName = nonEmpty(raw.location?.projectName);
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    type: raw.type ?? '',
    ...(projectKey ? { projectKey } : {}),
    ...(projectName ? { projectName } : {}),
  };
}

/**
 * Reshape a raw sprint to `{ id, name, state, …dates, goal?, boardId? }`.
 * Absent optional fields (a future sprint has no dates; an active one has no
 * `completeDate`) are dropped rather than emitted as empty strings.
 */
export function reshapeSprint(raw: RawSprint): CanonicalSprint {
  const startDate = nonEmpty(raw.startDate);
  const endDate = nonEmpty(raw.endDate);
  const completeDate = nonEmpty(raw.completeDate);
  const goal = nonEmpty(raw.goal);
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    state: raw.state ?? '',
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(completeDate ? { completeDate } : {}),
    ...(goal ? { goal } : {}),
    ...(raw.originBoardId !== undefined ? { boardId: raw.originBoardId } : {}),
  };
}

/**
 * Reshape a board `configuration` payload to `{ id, name, type, estimationField?,
 * columns }`. Surfaces the two things an agent needs for sprint reporting: the
 * estimation field id (so story points can be read without guessing
 * `customfield_NNNNN`) and the column → status mapping (status → board column).
 */
export function reshapeBoardConfig(raw: RawBoardConfig): CanonicalBoardConfig {
  const fieldId = nonEmpty(raw.estimation?.field?.fieldId);
  const fieldName = nonEmpty(raw.estimation?.field?.displayName);
  const columns: CanonicalBoardColumn[] = (raw.columnConfig?.columns ?? []).map((col) => ({
    name: col.name ?? '',
    statusIds: (col.statuses ?? [])
      .map((status) => status.id)
      .filter((id): id is string => typeof id === 'string' && id !== ''),
  }));
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    type: raw.type ?? '',
    ...(fieldId ? { estimationField: { id: fieldId, name: fieldName ?? '' } } : {}),
    columns,
  };
}
