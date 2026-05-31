import { describe, expect, it } from 'vitest';

import { reshapeVersion } from './jira-version-reshape.js';

describe('reshapeVersion', () => {
  it('keeps id, name, both boolean states, dates and description for a released version', () => {
    const out = reshapeVersion({
      id: '10100',
      name: '1.2.0',
      released: true,
      archived: false,
      description: 'Checkout revamp',
      startDate: '2026-04-01',
      releaseDate: '2026-04-30',
      overdue: false,
      self: 'https://x.atlassian.net/rest/api/3/version/10100',
      projectId: 100,
    } as never);
    expect(out).toEqual({
      id: '10100',
      name: '1.2.0',
      released: true,
      archived: false,
      description: 'Checkout revamp',
      startDate: '2026-04-01',
      releaseDate: '2026-04-30',
      overdue: false,
    });
  });

  it('always emits released/archived booleans (false is meaningful) and omits absent optionals', () => {
    const out = reshapeVersion({ id: '1', name: 'Next' });
    expect(out).toEqual({ id: '1', name: 'Next', released: false, archived: false });
    expect('releaseDate' in out).toBe(false);
    expect('description' in out).toBe(false);
    expect('overdue' in out).toBe(false);
  });

  it('surfaces overdue only when upstream reports it', () => {
    expect(reshapeVersion({ id: '2', name: 'Late', overdue: true }).overdue).toBe(true);
    expect('overdue' in reshapeVersion({ id: '3', name: 'OnTime' })).toBe(false);
  });

  it('drops a blank description / dates rather than emitting empty strings', () => {
    const out = reshapeVersion({ id: '4', name: 'V', description: '  ', releaseDate: '' });
    expect('description' in out).toBe(false);
    expect('releaseDate' in out).toBe(false);
  });

  it('defaults missing id/name to empty strings', () => {
    expect(reshapeVersion({})).toEqual({ id: '', name: '', released: false, archived: false });
  });
});
