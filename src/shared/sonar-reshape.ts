/**
 * Reshape raw Sonar issues / hotspots / measures into token-friendly canonical
 * forms. The raw responses are noisy: 25+ fields per issue with verbose
 * `flows`, `comments`, `transitions`, `quickFixAvailable`, etc. For a triage
 * agent the useful surface is ~10 fields.
 *
 * Key order is fixed (identity → severity → location → metadata) for cache-prefix stability.
 */

export interface CanonicalSonarIssue {
  readonly key: string;
  readonly rule: string;
  readonly severity: string;
  readonly type: string;
  readonly status: string;
  readonly component?: string;
  readonly line?: number;
  readonly message?: string;
  readonly author?: string;
  readonly effort?: string;
  readonly tags?: readonly string[];
  readonly creationDate?: string;
  readonly updateDate?: string;
}

interface RawSonarIssue {
  readonly key?: string;
  readonly rule?: string;
  readonly severity?: string;
  readonly type?: string;
  readonly status?: string;
  readonly component?: string;
  readonly line?: number;
  readonly message?: string;
  readonly author?: string;
  readonly effort?: string;
  readonly tags?: readonly string[];
  readonly creationDate?: string;
  readonly updateDate?: string;
}

/**
 * Reshape a raw Sonar Issue (z `/api/issues/search`) do token-friendly canonical
 * formy. Wycina 15+ szumowych pól (`flows`, `comments`, `transitions`,
 * `quickFixAvailable`, …) — zostaje ~10 pól relevant dla triage agenta.
 * @param raw Surowa issue z Sonar API (`api/issues/search` response.items[]).
 * @returns Canonical kształt z gwarantowanymi `key` / `rule` / `severity` / `type` / `status`.
 * @example
 * ```ts
 * const minimal = reshapeSonarIssue(await http.request({ path: '/api/issues/search' }));
 * agent.send(minimal); // ~70% mniej tokenów niż raw
 * ```
 */
export function reshapeSonarIssue(raw: RawSonarIssue): CanonicalSonarIssue {
  return {
    key: raw.key ?? '',
    rule: raw.rule ?? '',
    severity: raw.severity ?? 'INFO',
    type: raw.type ?? 'CODE_SMELL',
    status: raw.status ?? 'OPEN',
    ...(raw.component ? { component: raw.component } : {}),
    ...(typeof raw.line === 'number' ? { line: raw.line } : {}),
    ...(raw.message ? { message: raw.message } : {}),
    ...(raw.author ? { author: raw.author } : {}),
    ...(raw.effort ? { effort: raw.effort } : {}),
    ...(raw.tags && raw.tags.length > 0 ? { tags: raw.tags } : {}),
    ...(raw.creationDate ? { creationDate: raw.creationDate } : {}),
    ...(raw.updateDate ? { updateDate: raw.updateDate } : {}),
  };
}

export interface CanonicalHotspot {
  readonly key: string;
  readonly status: string;
  readonly resolution?: string;
  readonly securityCategory?: string;
  readonly vulnerabilityProbability?: string;
  readonly component?: string;
  readonly line?: number;
  readonly message?: string;
  readonly author?: string;
  readonly creationDate?: string;
  readonly updateDate?: string;
}

interface RawHotspot {
  readonly key?: string;
  readonly status?: string;
  readonly resolution?: string;
  readonly securityCategory?: string;
  readonly vulnerabilityProbability?: string;
  readonly component?: string;
  readonly line?: number;
  readonly message?: string;
  readonly author?: string;
  readonly creationDate?: string;
  readonly updateDate?: string;
}

/**
 * Reshape Security Hotspot (z `/api/hotspots/search`). Hotspot to bardziej
 * specjalizowany Issue z dodatkowymi polami `securityCategory` i `vulnerabilityProbability`
 * — reshape je zachowuje, ale tnie pozostały noise.
 * @param raw Surowy hotspot z Sonar API.
 * @returns Canonical kształt z gwarantowanym `key` / `status`.
 */
export function reshapeHotspot(raw: RawHotspot): CanonicalHotspot {
  return {
    key: raw.key ?? '',
    status: raw.status ?? 'TO_REVIEW',
    ...(raw.resolution ? { resolution: raw.resolution } : {}),
    ...(raw.securityCategory ? { securityCategory: raw.securityCategory } : {}),
    ...(raw.vulnerabilityProbability ? { vulnerabilityProbability: raw.vulnerabilityProbability } : {}),
    ...(raw.component ? { component: raw.component } : {}),
    ...(typeof raw.line === 'number' ? { line: raw.line } : {}),
    ...(raw.message ? { message: raw.message } : {}),
    ...(raw.author ? { author: raw.author } : {}),
    ...(raw.creationDate ? { creationDate: raw.creationDate } : {}),
    ...(raw.updateDate ? { updateDate: raw.updateDate } : {}),
  };
}

export interface CanonicalSonarProject {
  readonly key: string;
  readonly name: string;
  readonly qualifier?: string;
  readonly visibility?: string;
  readonly lastAnalysisDate?: string;
}

interface RawSonarProject {
  readonly key?: string;
  readonly name?: string;
  readonly qualifier?: string;
  readonly visibility?: string;
  readonly lastAnalysisDate?: string;
}

/**
 * Reshape a raw Sonar project (z `/api/projects/search` → `components[]`) do
 * token-friendly canonical formy. Surowy component niesie też `revision`,
 * `managed`, `tags`, `_links` — szum dla agenta listującego projekty.
 * @param raw Surowy component z Sonar API.
 * @returns Canonical kształt z gwarantowanym `key` / `name`.
 */
export function reshapeSonarProject(raw: RawSonarProject): CanonicalSonarProject {
  return {
    key: raw.key ?? '',
    name: raw.name ?? '',
    ...(raw.qualifier ? { qualifier: raw.qualifier } : {}),
    ...(raw.visibility ? { visibility: raw.visibility } : {}),
    ...(raw.lastAnalysisDate ? { lastAnalysisDate: raw.lastAnalysisDate } : {}),
  };
}
