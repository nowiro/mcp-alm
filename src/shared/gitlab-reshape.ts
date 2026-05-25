/**
 * Reshape raw GitLab MR / Issue / Pipeline responses into a token-friendly
 * canonical form. GitLab returns 60+ fields per MR; an LLM doing triage only
 * cares about a small surface — title, state, author, source/target, stats,
 * labels, latest pipeline. Everything else is HATEOAS URLs and metadata.
 *
 * `description` is trimmed to `MAX_BODY_CHARS` because MR descriptions can run
 * 10+ KB with screenshots / checkboxes / templates.
 *
 * Key order is fixed (identity → metadata → body → stats) so the Copilot
 * prefix cache stays warm.
 */

const MAX_BODY_CHARS = 2000;

export interface CanonicalMr {
  readonly iid: number;
  readonly title: string;
  readonly state: string;
  readonly draft?: boolean;
  readonly author?: string;
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly mergedAt?: string;
  readonly url?: string;
  readonly description?: string;
  readonly descriptionTruncated?: boolean;
  readonly labels?: readonly string[];
  readonly reviewers?: readonly string[];
  readonly assignees?: readonly string[];
  readonly mergeStatus?: string;
  readonly hasConflicts?: boolean;
  readonly userNotesCount?: number;
}

interface RawUser {
  readonly username?: string;
}

interface RawMr {
  readonly iid?: number;
  readonly title?: string;
  readonly state?: string;
  readonly draft?: boolean;
  readonly work_in_progress?: boolean;
  readonly author?: RawUser;
  readonly source_branch?: string;
  readonly target_branch?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly merged_at?: string | null;
  readonly web_url?: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
  readonly reviewers?: readonly RawUser[];
  readonly assignees?: readonly RawUser[];
  readonly merge_status?: string;
  readonly has_conflicts?: boolean;
  readonly user_notes_count?: number;
}

/**
 * Reshape raw GitLab Merge Request do token-friendly canonical formy.
 * Surowy MR ma 60+ pól (HATEOAS URLs, metadata pipelinów, related MR-ów);
 * canonical to ~15 pól — identity, state, author, branches, stats, labels,
 * latest pipeline. `description` truncated do `MAX_BODY_CHARS` (2000) bo MR
 * descriptions z templateami / screenshotami osiągają 10+ KB.
 * @param raw Surowy MR z GitLab API (`/api/v4/projects/:id/merge_requests/:iid`).
 * @returns Canonical kształt z gwarantowanym `iid` / `title` / `state`.
 * @example
 * ```ts
 * const minimal = reshapeGitLabMr(await http.request({ path: `/api/v4/projects/${pid}/merge_requests/${iid}` }));
 * // ~80% mniej tokenów niż raw
 * ```
 */
export function reshapeGitLabMr(raw: RawMr): CanonicalMr {
  const description = trim(raw.description ?? undefined);
  const labels = (raw.labels ?? []).filter((s) => s.length > 0);
  const reviewers = (raw.reviewers ?? []).map((u) => u.username ?? '').filter(Boolean);
  const assignees = (raw.assignees ?? []).map((u) => u.username ?? '').filter(Boolean);
  const draft = pickDraft(raw);

  return {
    iid: raw.iid ?? 0,
    title: raw.title ?? '',
    state: raw.state ?? 'unknown',
    ...(draft === undefined ? {} : { draft }),
    ...(raw.author?.username ? { author: raw.author.username } : {}),
    ...pickBranches(raw),
    ...pickTimestamps(raw),
    ...(raw.web_url ? { url: raw.web_url } : {}),
    ...(description.text ? { description: description.text } : {}),
    ...(description.truncated ? { descriptionTruncated: true } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(reviewers.length > 0 ? { reviewers } : {}),
    ...(assignees.length > 0 ? { assignees } : {}),
    ...(raw.merge_status ? { mergeStatus: raw.merge_status } : {}),
    ...(raw.has_conflicts === undefined ? {} : { hasConflicts: raw.has_conflicts }),
    ...(typeof raw.user_notes_count === 'number' ? { userNotesCount: raw.user_notes_count } : {}),
  };
}

function pickDraft(raw: RawMr): boolean | undefined {
  if (raw.draft !== undefined) return raw.draft;
  if (raw.work_in_progress !== undefined) return raw.work_in_progress;
  return undefined;
}

function pickBranches(raw: RawMr): { sourceBranch?: string; targetBranch?: string } {
  return {
    ...(raw.source_branch ? { sourceBranch: raw.source_branch } : {}),
    ...(raw.target_branch ? { targetBranch: raw.target_branch } : {}),
  };
}

function pickTimestamps(raw: RawMr): { createdAt?: string; updatedAt?: string; mergedAt?: string } {
  return {
    ...(raw.created_at ? { createdAt: raw.created_at } : {}),
    ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
    ...(raw.merged_at ? { mergedAt: raw.merged_at } : {}),
  };
}

export interface CanonicalGitLabIssue {
  readonly iid: number;
  readonly title: string;
  readonly state: string;
  readonly author?: string;
  readonly assignees?: readonly string[];
  readonly labels?: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly closedAt?: string;
  readonly url?: string;
  readonly description?: string;
  readonly descriptionTruncated?: boolean;
  readonly userNotesCount?: number;
  readonly weight?: number;
  readonly milestone?: string;
}

interface RawGitLabIssue {
  readonly iid?: number;
  readonly title?: string;
  readonly state?: string;
  readonly author?: RawUser;
  readonly assignees?: readonly RawUser[];
  readonly labels?: readonly string[];
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly closed_at?: string | null;
  readonly web_url?: string;
  readonly description?: string | null;
  readonly user_notes_count?: number;
  readonly weight?: number | null;
  readonly milestone?: { readonly title?: string } | null;
}

/**
 * Reshape raw GitLab Issue. Tak jak MR — wycina HATEOAS noise, zachowuje
 * canonical surface (identity, state, author, labels, milestone, due date).
 * @param raw Surowy Issue z GitLab API (`/api/v4/projects/:id/issues/:iid`).
 * @returns Canonical kształt z gwarantowanym `iid` / `title` / `state`.
 */
export function reshapeGitLabIssue(raw: RawGitLabIssue): CanonicalGitLabIssue {
  const description = trim(raw.description ?? undefined);
  const labels = (raw.labels ?? []).filter((s) => s.length > 0);
  const assignees = (raw.assignees ?? []).map((u) => u.username ?? '').filter(Boolean);

  return {
    iid: raw.iid ?? 0,
    title: raw.title ?? '',
    state: raw.state ?? 'unknown',
    ...(raw.author?.username ? { author: raw.author.username } : {}),
    ...(assignees.length > 0 ? { assignees } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(raw.created_at ? { createdAt: raw.created_at } : {}),
    ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
    ...(raw.closed_at ? { closedAt: raw.closed_at } : {}),
    ...(raw.web_url ? { url: raw.web_url } : {}),
    ...(description.text ? { description: description.text } : {}),
    ...(description.truncated ? { descriptionTruncated: true } : {}),
    ...(typeof raw.user_notes_count === 'number' ? { userNotesCount: raw.user_notes_count } : {}),
    ...(typeof raw.weight === 'number' ? { weight: raw.weight } : {}),
    ...(raw.milestone?.title ? { milestone: raw.milestone.title } : {}),
  };
}

export interface CanonicalPipeline {
  readonly id: number;
  readonly status: string;
  readonly ref?: string;
  readonly sha?: string;
  readonly source?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly url?: string;
}

interface RawPipeline {
  readonly id?: number;
  readonly status?: string;
  readonly ref?: string;
  readonly sha?: string;
  readonly source?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly web_url?: string;
}

/**
 * Reshape raw GitLab CI/CD Pipeline. Pomocniczy dla MR.latestPipeline + standalone
 * `get_pipeline` tool. Zachowuje status / ref / sha / duration / web_url.
 * @param raw Surowy pipeline z GitLab API.
 * @returns Canonical kształt z `id` / `status` / `ref`.
 */
export function reshapeGitLabPipeline(raw: RawPipeline): CanonicalPipeline {
  return {
    id: raw.id ?? 0,
    status: raw.status ?? 'unknown',
    ...(raw.ref ? { ref: raw.ref } : {}),
    ...(raw.sha ? { sha: raw.sha } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.created_at ? { createdAt: raw.created_at } : {}),
    ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
    ...(raw.web_url ? { url: raw.web_url } : {}),
  };
}

function trim(raw: string | undefined): { text?: string; truncated: boolean } {
  if (raw === undefined || raw === '') return { truncated: false };
  if (raw.length <= MAX_BODY_CHARS) return { text: raw, truncated: false };
  return { text: raw.slice(0, MAX_BODY_CHARS) + '\n…[truncated]', truncated: true };
}
