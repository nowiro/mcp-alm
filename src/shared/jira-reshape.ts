/**
 * Reshape a raw Jira issue into a token-friendly canonical form.
 *
 * Three problems we solve here:
 *   1. **Custom field IDs** — `customfield_10042` → "Story Points" via the
 *      lazy `FieldRegistry`. If the registry hasn't loaded (or the token can't
 *      see field metadata), the original ID is kept so the LLM still has a
 *      handle.
 *   2. **ADF descriptions** — the raw API returns ADF JSON which the LLM
 *      cannot read efficiently. We render it through `adfToMarkdown`.
 *   3. **Field bloat** — 50+ fields per issue is normal; most are noise for
 *      the LLM (icons, avatars, _links, expand markers). We keep the system
 *      fields a human cares about + every populated custom field.
 *
 * Key order is fixed (`key` → `id` → identity → metadata → body → custom)
 * so the Copilot prefix cache stays warm across calls.
 */
import { adfToMarkdown } from './adf.js';
import { reshapeFieldValue, type FieldRegistry, type ReshapedField } from './field-registry.js';

/** Cap on rendered Jira description Markdown — mirrors Confluence's 8 000 char default. */
const MAX_DESCRIPTION_CHARS = 8000;

export interface CanonicalIssue {
  readonly key: string;
  readonly id: string;
  readonly url?: string;
  readonly summary?: string;
  readonly status?: { id: string; name: string };
  readonly issueType?: { id: string; name: string };
  readonly priority?: { id: string; name: string };
  readonly assignee?: { accountId: string; displayName: string };
  readonly reporter?: { accountId: string; displayName: string };
  readonly labels?: readonly string[];
  readonly created?: string;
  readonly updated?: string;
  readonly descriptionMd?: string;
  readonly descriptionTruncated?: boolean;
  readonly customFields?: readonly ReshapedField[];
}

interface RawIssue {
  readonly id: string;
  readonly key: string;
  readonly self?: string;
  readonly fields?: Record<string, unknown>;
}

const SYSTEM_FIELDS = new Set([
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'created',
  'updated',
  'description',
]);

export function reshapeJiraIssue(raw: RawIssue, registry: FieldRegistry): CanonicalIssue {
  const fields = raw.fields ?? {};
  const customFields = collectCustomFields(fields, registry);
  const fullDescription = fields['description'] ? adfToMarkdown(fields['description'] as never) : '';
  const description = capDescription(fullDescription);
  const systemSlice = pickSystemSlice(fields, raw.self);

  // Single explicit literal — no spread within identity, optional system fields
  // are merged via one slice. Optional `undefined` values are dropped by
  // `JSON.stringify` natively, so the wire JSON keeps a stable key order.
  return {
    key: raw.key,
    id: raw.id,
    ...systemSlice,
    ...(description.text.length > 0 ? { descriptionMd: description.text } : {}),
    ...(description.truncated ? { descriptionTruncated: true } : {}),
    ...(customFields.length > 0 ? { customFields } : {}),
  };
}

function capDescription(full: string): { text: string; truncated: boolean } {
  if (full.length <= MAX_DESCRIPTION_CHARS) return { text: full, truncated: false };
  return { text: full.slice(0, MAX_DESCRIPTION_CHARS) + '\n…[truncated]', truncated: true };
}

/** Walk all `customfield_*` (and any non-system) entries, dropping null/empty/unknown noise. */
function collectCustomFields(fields: Record<string, unknown>, registry: FieldRegistry): ReshapedField[] {
  const out: ReshapedField[] = [];
  for (const [id, value] of Object.entries(fields)) {
    if (isCustomFieldKeeper(id, value)) {
      const reshaped = reshapeFieldValue(registry.byId(id), value);
      if (reshaped) out.push(reshaped);
    }
  }
  return out;
}

/** Positive guard — keep when not a system key, not nullish, not an empty array. */
function isCustomFieldKeeper(id: string, value: unknown): boolean {
  if (SYSTEM_FIELDS.has(id)) return false;
  if (value === null || value === undefined) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/** Mutable mirror of the optional system fields — flipped to `readonly` on return. */
interface MutableSystemSlice {
  url?: string;
  summary?: string;
  status?: { id: string; name: string };
  issueType?: { id: string; name: string };
  priority?: { id: string; name: string };
  assignee?: { accountId: string; displayName: string };
  reporter?: { accountId: string; displayName: string };
  labels?: readonly string[];
  created?: string;
  updated?: string;
}

/**
 * Gather all optional system fields in one slice with stable key order — keeps
 * the cognitive cap on `reshapeJiraIssue` and the wire JSON deterministic.
 */
function pickSystemSlice(fields: Record<string, unknown>, self: string | undefined): MutableSystemSlice {
  const slice: MutableSystemSlice = {};
  if (self) slice.url = self;
  if (typeof fields['summary'] === 'string') slice.summary = fields['summary'];
  const status = pickIdName(fields['status']);
  if (status) slice.status = status;
  const issueType = pickIdName(fields['issuetype']);
  if (issueType) slice.issueType = issueType;
  const priority = pickIdName(fields['priority']);
  if (priority) slice.priority = priority;
  const assignee = pickUser(fields['assignee']);
  if (assignee) slice.assignee = assignee;
  const reporter = pickUser(fields['reporter']);
  if (reporter) slice.reporter = reporter;
  if (Array.isArray(fields['labels'])) slice.labels = fields['labels'] as readonly string[];
  if (typeof fields['created'] === 'string') slice.created = fields['created'];
  if (typeof fields['updated'] === 'string') slice.updated = fields['updated'];
  return slice;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function pickIdName(raw: unknown): { id: string; name: string } | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  return id || name ? { id, name } : undefined;
}

function pickUser(raw: unknown): { accountId: string; displayName: string } | undefined {
  if (!isObject(raw)) return undefined;
  const accountId = typeof raw['accountId'] === 'string' ? raw['accountId'] : '';
  const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'] : '';
  return accountId || displayName ? { accountId, displayName } : undefined;
}
