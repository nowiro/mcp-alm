/**
 * Unit tests — reshapeSonarProject (token-friendly Sonar project shape for
 * `sonar.list_projects`).
 */
import { describe, expect, it } from 'vitest';

import { reshapeSonarProject } from './sonar-reshape.js';

describe('reshapeSonarProject', () => {
  it('keeps the canonical surface', () => {
    const out = reshapeSonarProject({
      key: 'my-svc',
      name: 'My Service',
      qualifier: 'TRK',
      visibility: 'private',
      lastAnalysisDate: '2026-05-01T10:00:00+0000',
    });
    expect(out).toEqual({
      key: 'my-svc',
      name: 'My Service',
      qualifier: 'TRK',
      visibility: 'private',
      lastAnalysisDate: '2026-05-01T10:00:00+0000',
    });
  });

  it('guarantees key + name and omits absent optionals', () => {
    const out = reshapeSonarProject({ key: 'k' });
    expect(out).toEqual({ key: 'k', name: '' });
    expect('qualifier' in out).toBe(false);
    expect('visibility' in out).toBe(false);
    expect('lastAnalysisDate' in out).toBe(false);
  });
});
