/**
 * Testy dla deterministycznych części `extract-sonar.ts`:
 *   - schema configu (discriminated union: quality_gate / issues / hotspots / measures)
 *   - renderers Markdown (pure functions)
 */
import { describe, expect, it } from 'vitest';

import {
  ExtractConfig,
  renderHotspotsMarkdown,
  renderIssuesMarkdown,
  renderMeasuresMarkdown,
  renderQualityGateMarkdown,
  type HotspotsSummary,
  type IssuesSummary,
  type MeasuresSummary,
  type QualityGateSummary,
} from './extract-sonar.js';

describe('ExtractConfig (Sonar)', () => {
  it('parses quality_gate snapshot', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'main', type: 'quality_gate', projectKey: 'my-project' }],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'quality_gate') throw new Error('expected quality_gate');
    expect(snap.projectKey).toBe('my-project');
    expect(snap.render).toEqual(['json', 'markdown']);
  });

  it('parses issues snapshot with severity filter', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [
        {
          name: 'criticals',
          type: 'issues',
          projectKey: 'p',
          severities: ['CRITICAL', 'BLOCKER'],
          types: ['BUG'],
        },
      ],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'issues') throw new Error('expected issues');
    expect(snap.severities).toEqual(['CRITICAL', 'BLOCKER']);
    expect(snap.types).toEqual(['BUG']);
    expect(snap.maxItems).toBe(5000);
  });

  it('parses hotspots snapshot with status', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [{ name: 'pending', type: 'hotspots', projectKey: 'p', status: 'TO_REVIEW' }],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'hotspots') throw new Error('expected hotspots');
    expect(snap.status).toBe('TO_REVIEW');
  });

  it('parses measures snapshot with metric list', () => {
    const parsed = ExtractConfig.parse({
      snapshots: [
        {
          name: 'core',
          type: 'measures',
          projectKey: 'p',
          metrics: ['coverage', 'duplicated_lines_density', 'ncloc'],
        },
      ],
    });
    const [snap] = parsed.snapshots;
    if (!snap) throw new Error('expected snapshot');
    if (snap.type !== 'measures') throw new Error('expected measures');
    expect(snap.metrics).toEqual(['coverage', 'duplicated_lines_density', 'ncloc']);
  });

  it('rejects measures without metric list', () => {
    expect(() =>
      ExtractConfig.parse({ snapshots: [{ name: 'x', type: 'measures', projectKey: 'p', metrics: [] }] }),
    ).toThrow();
  });

  it('rejects invalid severity', () => {
    expect(() =>
      ExtractConfig.parse({
        snapshots: [{ name: 'x', type: 'issues', projectKey: 'p', severities: ['EMERGENCY' as 'CRITICAL'] }],
      }),
    ).toThrow();
  });
});

describe('renderQualityGateMarkdown', () => {
  const minimal: QualityGateSummary = {
    projectKey: 'my-project',
    status: 'OK',
    conditions: [],
  };

  it('produces header with project key', () => {
    expect(renderQualityGateMarkdown(minimal)).toMatch(/^# Quality Gate — my-project/);
  });

  it('shows branch / PR suffix when present', () => {
    const mdBranch = renderQualityGateMarkdown({ ...minimal, branch: 'develop' });
    expect(mdBranch).toContain('(branch `develop`)');
    const mdPr = renderQualityGateMarkdown({ ...minimal, pullRequest: '42' });
    expect(mdPr).toContain('(PR `42`)');
  });

  it('renders conditions table when present', () => {
    const md = renderQualityGateMarkdown({
      ...minimal,
      status: 'ERROR',
      conditions: [
        { metricKey: 'new_coverage', status: 'ERROR', comparator: 'LT', errorThreshold: '80', actualValue: '65' },
        { metricKey: 'new_bugs', status: 'OK', comparator: 'GT', errorThreshold: '0', actualValue: '0' },
      ],
    });
    expect(md).toContain('**Status**: `ERROR`');
    expect(md).toContain('| `new_coverage` | ERROR | 65 | 80 | LT |');
    expect(md).toContain('| `new_bugs` | OK | 0 | 0 | GT |');
  });

  it('is deterministic', () => {
    const qg: QualityGateSummary = {
      projectKey: 'p',
      branch: 'main',
      status: 'OK',
      conditions: [{ metricKey: 'm', status: 'OK', actualValue: '1' }],
    };
    expect(renderQualityGateMarkdown(qg)).toBe(renderQualityGateMarkdown(qg));
  });
});

describe('renderIssuesMarkdown', () => {
  it('renders summary with totals and filters', () => {
    const summary: IssuesSummary = {
      projectKey: 'p',
      filters: { severities: ['CRITICAL'], branch: 'main' },
      total: 100,
      truncated: true,
      issues: [
        {
          key: 'AY-1',
          rule: 'java:S1234',
          severity: 'CRITICAL',
          type: 'BUG',
          status: 'OPEN',
          component: 'src/Foo.java',
          line: 42,
        },
      ],
    };
    const md = renderIssuesMarkdown(summary);
    expect(md).toContain('**Total upstream**: 100');
    expect(md).toContain('**Wyciągnięte**: 1');
    expect(md).toContain('**Truncated**: TAK');
    expect(md).toContain('severities=CRITICAL');
    expect(md).toContain('branch=main');
    expect(md).toContain('| `AY-1` | CRITICAL | BUG | OPEN | `java:S1234` | src/Foo.java | 42 |');
  });

  it('omits issues table when zero issues', () => {
    const md = renderIssuesMarkdown({
      projectKey: 'p',
      filters: {},
      total: 0,
      truncated: false,
      issues: [],
    });
    expect(md).not.toContain('## Issues');
  });
});

describe('renderHotspotsMarkdown', () => {
  it('renders hotspot rows', () => {
    const summary: HotspotsSummary = {
      projectKey: 'p',
      filters: { status: 'TO_REVIEW' },
      total: 2,
      truncated: false,
      hotspots: [
        {
          key: 'H-1',
          status: 'TO_REVIEW',
          vulnerabilityProbability: 'HIGH',
          securityCategory: 'sql-injection',
          component: 'src/Db.java',
          line: 10,
        },
      ],
    };
    const md = renderHotspotsMarkdown(summary);
    expect(md).toContain('| `H-1` | TO_REVIEW | HIGH | sql-injection | src/Db.java | 10 |');
  });
});

describe('renderMeasuresMarkdown', () => {
  it('renders metric table with best-value marker', () => {
    const summary: MeasuresSummary = {
      projectKey: 'p',
      measures: [
        { metric: 'coverage', value: '85.4', bestValue: false },
        { metric: 'duplicated_lines_density', value: '0.0', bestValue: true },
      ],
    };
    const md = renderMeasuresMarkdown(summary);
    expect(md).toContain('| `coverage` | 85.4 |  |');
    expect(md).toContain('| `duplicated_lines_density` | 0.0 | ✓ |');
  });
});
