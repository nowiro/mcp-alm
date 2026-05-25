import { describe, expect, it } from 'vitest';

import { diffGateStatuses, type SonarProjectStatus } from './sonar-gate-diff.js';

function status(
  overall: 'OK' | 'ERROR' | 'NONE',
  conditions: ReadonlyArray<{
    metricKey: string;
    status: 'OK' | 'ERROR' | 'WARN' | 'NO_VALUE';
    actualValue?: string;
  }>,
): SonarProjectStatus {
  return { status: overall, conditions };
}

describe('diffGateStatuses', () => {
  it('classifies a worsening condition as a regression with the new status and value', () => {
    const base = status('OK', [{ metricKey: 'coverage', status: 'OK', actualValue: '85' }]);
    const pr = status('ERROR', [{ metricKey: 'coverage', status: 'ERROR', actualValue: '60' }]);

    const result = diffGateStatuses(pr, base);

    expect(result.regressions).toEqual([
      {
        metric: 'coverage',
        base_value: '85',
        pr_value: '60',
        delta: '-25',
        condition_status: 'ERROR',
      },
    ]);
    expect(result.improvements).toEqual([]);
    expect(result.summary).toEqual({
      regression_count: 1,
      improvement_count: 0,
      net_change: 'regressed',
    });
  });

  it('classifies an improving condition as an improvement and reports improved net change', () => {
    const base = status('ERROR', [{ metricKey: 'bugs', status: 'ERROR', actualValue: '12' }]);
    const pr = status('OK', [{ metricKey: 'bugs', status: 'OK', actualValue: '2' }]);

    const result = diffGateStatuses(pr, base);

    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([{ metric: 'bugs', base_value: '12', pr_value: '2' }]);
    expect(result.summary.net_change).toBe('improved');
  });

  it('reports unchanged when PR and base have identical conditions', () => {
    const conditions = [
      { metricKey: 'coverage', status: 'OK' as const, actualValue: '90' },
      { metricKey: 'bugs', status: 'OK' as const, actualValue: '0' },
    ];
    const result = diffGateStatuses(status('OK', conditions), status('OK', conditions));

    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
    expect(result.summary).toEqual({
      regression_count: 0,
      improvement_count: 0,
      net_change: 'unchanged',
    });
  });

  it('treats a new failing condition on the PR side as a regression with no base value', () => {
    const base = status('OK', []);
    const pr = status('ERROR', [{ metricKey: 'new_security_hotspots', status: 'ERROR', actualValue: '4' }]);

    const result = diffGateStatuses(pr, base);

    expect(result.regressions).toEqual([
      {
        metric: 'new_security_hotspots',
        base_value: null,
        pr_value: '4',
        delta: null,
        condition_status: 'ERROR',
      },
    ]);
    expect(result.improvements).toEqual([]);
  });

  it('does not report a new OK condition on the PR side as a regression', () => {
    const base = status('OK', []);
    const pr = status('OK', [{ metricKey: 'coverage', status: 'OK', actualValue: '95' }]);

    const result = diffGateStatuses(pr, base);

    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
    expect(result.summary.net_change).toBe('unchanged');
  });

  it('treats a failing base-side condition dropped on the PR as an improvement', () => {
    const base = status('ERROR', [{ metricKey: 'duplicated_lines_density', status: 'ERROR', actualValue: '15' }]);
    const pr = status('OK', []);

    const result = diffGateStatuses(pr, base);

    expect(result.improvements).toEqual([{ metric: 'duplicated_lines_density', base_value: '15', pr_value: null }]);
    expect(result.regressions).toEqual([]);
    expect(result.summary.net_change).toBe('improved');
  });

  it('handles missing actualValue by returning null values and null delta', () => {
    const base = status('OK', [{ metricKey: 'coverage', status: 'OK' }]);
    const pr = status('ERROR', [{ metricKey: 'coverage', status: 'ERROR' }]);

    const result = diffGateStatuses(pr, base);

    expect(result.regressions).toEqual([
      {
        metric: 'coverage',
        base_value: null,
        pr_value: null,
        delta: null,
        condition_status: 'ERROR',
      },
    ]);
  });

  it('handles non-numeric actual values by returning a null delta', () => {
    const base = status('OK', [{ metricKey: 'alert_status', status: 'OK', actualValue: 'OK' }]);
    const pr = status('ERROR', [{ metricKey: 'alert_status', status: 'ERROR', actualValue: 'ERROR' }]);

    const result = diffGateStatuses(pr, base);

    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]?.delta).toBeNull();
    expect(result.regressions[0]?.condition_status).toBe('ERROR');
  });

  it('mixes regressions and improvements and chooses net_change by majority', () => {
    const base = status('ERROR', [
      { metricKey: 'bugs', status: 'ERROR', actualValue: '10' },
      { metricKey: 'coverage', status: 'OK', actualValue: '90' },
      { metricKey: 'code_smells', status: 'OK', actualValue: '5' },
    ]);
    const pr = status('ERROR', [
      { metricKey: 'bugs', status: 'OK', actualValue: '0' }, // improvement
      { metricKey: 'coverage', status: 'ERROR', actualValue: '70' }, // regression
      { metricKey: 'code_smells', status: 'ERROR', actualValue: '40' }, // regression
    ]);

    const result = diffGateStatuses(pr, base);

    expect(result.regressions.map((r) => r.metric)).toEqual(['code_smells', 'coverage']);
    expect(result.improvements.map((i) => i.metric)).toEqual(['bugs']);
    expect(result.summary).toEqual({
      regression_count: 2,
      improvement_count: 1,
      net_change: 'regressed',
    });
  });

  it('handles undefined conditions arrays on either side without throwing', () => {
    const base: SonarProjectStatus = { status: 'NONE' };
    const pr: SonarProjectStatus = { status: 'NONE' };

    const result = diffGateStatuses(pr, base);

    expect(result).toEqual({
      regressions: [],
      improvements: [],
      summary: { regression_count: 0, improvement_count: 0, net_change: 'unchanged' },
    });
  });
});
