/**
 * Pure helpers for diffing two SonarQube / SonarCloud `ProjectStatus` payloads.
 *
 * The "PR vs base" comparison powers `sonar.get_quality_gate_diff`: callers
 * fetch the gate twice (once for the pull request, once for the base branch)
 * and feed both into {@link diffGateStatuses} to classify every condition as
 * a regression, an improvement, or unchanged.
 *
 * The functions in this module never touch the network — they only reshape
 * already-fetched data, which keeps them trivially unit-testable.
 */

/** Single quality-gate condition as returned by Sonar's `project_status` endpoint. */
export interface SonarCondition {
  readonly metricKey: string;
  readonly status: 'OK' | 'ERROR' | 'WARN' | 'NO_VALUE';
  readonly actualValue?: string;
  readonly errorThreshold?: string;
  readonly comparator?: string;
  readonly periodIndex?: number;
}

/** Project-status payload (subset we depend on). */
export interface SonarProjectStatus {
  readonly status: 'OK' | 'ERROR' | 'NONE';
  readonly conditions?: readonly SonarCondition[];
}

/** A condition whose status got worse on the PR side. */
export interface GateRegression {
  readonly metric: string;
  readonly base_value: string | null;
  readonly pr_value: string | null;
  readonly delta: string | null;
  readonly condition_status: 'OK' | 'ERROR' | 'WARN' | 'NO_VALUE';
}

/** A condition whose status got better on the PR side. */
export interface GateImprovement {
  readonly metric: string;
  readonly base_value: string | null;
  readonly pr_value: string | null;
}

/** Aggregate counts and a net direction across all compared conditions. */
export interface GateDiffSummary {
  readonly regression_count: number;
  readonly improvement_count: number;
  readonly net_change: 'improved' | 'regressed' | 'unchanged';
}

/** Output of {@link diffGateStatuses}. */
export interface GateDiffResult {
  readonly regressions: readonly GateRegression[];
  readonly improvements: readonly GateImprovement[];
  readonly summary: GateDiffSummary;
}

const STATUS_RANK: Readonly<Record<SonarCondition['status'], number>> = {
  OK: 0,
  NO_VALUE: 1,
  WARN: 2,
  ERROR: 3,
};

function toMap(conditions: readonly SonarCondition[] | undefined): Map<string, SonarCondition> {
  const map = new Map<string, SonarCondition>();
  if (!conditions) return map;
  for (const c of conditions) {
    if (typeof c.metricKey === 'string' && c.metricKey.length > 0) {
      map.set(c.metricKey, c);
    }
  }
  return map;
}

function valueOrNull(c: SonarCondition | undefined): string | null {
  if (!c) return null;
  const v = c.actualValue;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function computeDelta(baseValue: string | null, prValue: string | null): string | null {
  if (baseValue === null || prValue === null) return null;
  const baseNumber = Number(baseValue);
  const prNumber = Number(prValue);
  if (!Number.isFinite(baseNumber) || !Number.isFinite(prNumber)) return null;
  const diff = prNumber - baseNumber;
  if (diff === 0) return '0';
  const sign = diff > 0 ? '+' : '';
  // Trim trailing zeros for readability while keeping integers integer-shaped.
  const text = Number.isInteger(diff) ? String(diff) : String(Number(diff.toFixed(4)));
  return `${sign}${text}`;
}

/**
 * Compare a PR-scoped `ProjectStatus` against a base-branch-scoped one and
 * classify every condition.
 *
 * Rules:
 * - **Regression**: condition status got strictly worse (rank increase) or the
 *   PR introduced a new failing condition that didn't exist on base.
 * - **Improvement**: condition status got strictly better (rank decrease) or
 *   the PR cleared a base-side failure.
 * - **Unchanged** conditions are silently dropped from both lists.
 * @param pr - PR-scoped project status
 * @param base - Base-branch-scoped project status
 */
interface MetricBuckets {
  readonly regressions: GateRegression[];
  readonly improvements: GateImprovement[];
}

function classifyNewCondition(
  metric: string,
  prCond: SonarCondition,
  prValue: string | null,
  buckets: MetricBuckets,
): void {
  if (prCond.status === 'ERROR' || prCond.status === 'WARN' || prCond.status === 'NO_VALUE') {
    buckets.regressions.push({
      metric,
      base_value: null,
      pr_value: prValue,
      delta: null,
      condition_status: prCond.status,
    });
  }
}

function classifyDroppedCondition(
  metric: string,
  baseCond: SonarCondition,
  baseValue: string | null,
  buckets: MetricBuckets,
): void {
  if (baseCond.status === 'ERROR' || baseCond.status === 'WARN' || baseCond.status === 'NO_VALUE') {
    buckets.improvements.push({ metric, base_value: baseValue, pr_value: null });
  }
}

function classifyBothPresent(
  metric: string,
  prCond: SonarCondition,
  baseCond: SonarCondition,
  prValue: string | null,
  baseValue: string | null,
  buckets: MetricBuckets,
): void {
  const prRank = STATUS_RANK[prCond.status];
  const baseRank = STATUS_RANK[baseCond.status];
  if (prRank > baseRank) {
    buckets.regressions.push({
      metric,
      base_value: baseValue,
      pr_value: prValue,
      delta: computeDelta(baseValue, prValue),
      condition_status: prCond.status,
    });
  } else if (prRank < baseRank) {
    buckets.improvements.push({ metric, base_value: baseValue, pr_value: prValue });
  }
}

function netChangeOf(regressionCount: number, improvementCount: number): GateDiffSummary['net_change'] {
  if (regressionCount > improvementCount) return 'regressed';
  if (improvementCount > regressionCount) return 'improved';
  return 'unchanged';
}

export function diffGateStatuses(pr: SonarProjectStatus, base: SonarProjectStatus): GateDiffResult {
  const prMap = toMap(pr.conditions);
  const baseMap = toMap(base.conditions);
  const buckets: MetricBuckets = { regressions: [], improvements: [] };

  const allMetrics = new Set<string>([...prMap.keys(), ...baseMap.keys()]);
  const sortedMetrics = [...allMetrics].toSorted((a, b) => a.localeCompare(b));

  for (const metric of sortedMetrics) {
    const prCond = prMap.get(metric);
    const baseCond = baseMap.get(metric);
    const baseValue = valueOrNull(baseCond);
    const prValue = valueOrNull(prCond);

    if (prCond && !baseCond) classifyNewCondition(metric, prCond, prValue, buckets);
    else if (!prCond && baseCond) classifyDroppedCondition(metric, baseCond, baseValue, buckets);
    else if (prCond && baseCond) classifyBothPresent(metric, prCond, baseCond, prValue, baseValue, buckets);
  }

  const { regressions, improvements } = buckets;
  const regressionCount = regressions.length;
  const improvementCount = improvements.length;
  const netChange: GateDiffSummary['net_change'] = netChangeOf(regressionCount, improvementCount);

  return {
    regressions,
    improvements,
    summary: {
      regression_count: regressionCount,
      improvement_count: improvementCount,
      net_change: netChange,
    },
  };
}
