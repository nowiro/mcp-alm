import { describe, expect, it } from 'vitest';

import { reshapeBoard, reshapeBoardConfig, reshapeSprint } from './jira-agile-reshape.js';

describe('reshapeBoard', () => {
  it('keeps id, name, type and flattens location.projectKey / projectName', () => {
    const out = reshapeBoard({
      id: 12,
      name: 'PROJ board',
      type: 'scrum',
      location: { projectKey: 'PROJ', projectName: 'Project X', projectId: 100 } as never,
    });
    expect(out).toEqual({
      id: 12,
      name: 'PROJ board',
      type: 'scrum',
      projectKey: 'PROJ',
      projectName: 'Project X',
    });
  });

  it('omits project fields when there is no location', () => {
    const out = reshapeBoard({ id: 1, name: 'Kanban', type: 'kanban' });
    expect(out).toEqual({ id: 1, name: 'Kanban', type: 'kanban' });
    expect('projectKey' in out).toBe(false);
    expect('projectName' in out).toBe(false);
  });

  it('drops blank project fields rather than emitting empty strings', () => {
    const out = reshapeBoard({
      id: 2,
      name: 'B',
      type: 'simple',
      location: { projectKey: '   ', projectName: '' },
    });
    expect('projectKey' in out).toBe(false);
    expect('projectName' in out).toBe(false);
  });

  it('defaults missing id/name/type to safe primitives', () => {
    const out = reshapeBoard({});
    expect(out).toEqual({ id: 0, name: '', type: '' });
  });
});

describe('reshapeSprint', () => {
  it('keeps id, name, state and all three dates + goal for a closed sprint', () => {
    const out = reshapeSprint({
      id: 44,
      name: 'Sprint 7',
      state: 'closed',
      startDate: '2026-04-01T00:00:00.000Z',
      endDate: '2026-04-14T00:00:00.000Z',
      completeDate: '2026-04-15T09:30:00.000Z',
      goal: 'Ship checkout v2',
      originBoardId: 12,
    });
    expect(out).toEqual({
      id: 44,
      name: 'Sprint 7',
      state: 'closed',
      startDate: '2026-04-01T00:00:00.000Z',
      endDate: '2026-04-14T00:00:00.000Z',
      completeDate: '2026-04-15T09:30:00.000Z',
      goal: 'Ship checkout v2',
      boardId: 12,
    });
  });

  it('renames originBoardId to boardId', () => {
    const out = reshapeSprint({ id: 1, name: 'S', state: 'active', originBoardId: 99 });
    expect(out.boardId).toBe(99);
    expect('originBoardId' in out).toBe(false);
  });

  it('omits completeDate for an active sprint and dates for a future sprint', () => {
    const active = reshapeSprint({
      id: 2,
      name: 'Active',
      state: 'active',
      startDate: '2026-05-01T00:00:00.000Z',
      endDate: '2026-05-14T00:00:00.000Z',
    });
    expect('completeDate' in active).toBe(false);

    const future = reshapeSprint({ id: 3, name: 'Future', state: 'future' });
    expect(future).toEqual({ id: 3, name: 'Future', state: 'future' });
    expect('startDate' in future).toBe(false);
    expect('endDate' in future).toBe(false);
  });

  it('drops a blank goal rather than emitting an empty string', () => {
    const out = reshapeSprint({ id: 4, name: 'S', state: 'active', goal: '  ' });
    expect('goal' in out).toBe(false);
  });

  it('omits boardId when originBoardId is absent', () => {
    const out = reshapeSprint({ id: 5, name: 'S', state: 'active' });
    expect('boardId' in out).toBe(false);
  });

  it('defaults missing id/name/state to safe primitives', () => {
    expect(reshapeSprint({})).toEqual({ id: 0, name: '', state: '' });
  });
});

describe('reshapeBoardConfig', () => {
  it('extracts estimation field + columns with mapped status ids', () => {
    const out = reshapeBoardConfig({
      id: 10,
      name: 'PROJ board',
      type: 'scrum',
      columnConfig: {
        columns: [
          { name: 'To Do', statuses: [{ id: '10000' }, { id: '3' }] },
          { name: 'Done', statuses: [{ id: '10001' }] },
        ],
      },
      estimation: { field: { fieldId: 'customfield_10016', displayName: 'Story Points' } },
    });
    expect(out).toEqual({
      id: 10,
      name: 'PROJ board',
      type: 'scrum',
      estimationField: { id: 'customfield_10016', name: 'Story Points' },
      columns: [
        { name: 'To Do', statusIds: ['10000', '3'] },
        { name: 'Done', statusIds: ['10001'] },
      ],
    });
  });

  it('omits estimationField when the board has no estimation', () => {
    const out = reshapeBoardConfig({ id: 1, name: 'Kanban', type: 'kanban', columnConfig: { columns: [] } });
    expect('estimationField' in out).toBe(false);
    expect(out.columns).toEqual([]);
  });

  it('keeps a column with no statuses as an empty statusIds array and drops blank status ids', () => {
    const out = reshapeBoardConfig({
      id: 2,
      name: 'B',
      type: 'scrum',
      columnConfig: { columns: [{ name: 'Backlog' }, { name: 'Doing', statuses: [{ id: '' }, { id: '5' }] }] },
    });
    expect(out.columns).toEqual([
      { name: 'Backlog', statusIds: [] },
      { name: 'Doing', statusIds: ['5'] },
    ]);
  });

  it('defaults missing id/name/type and yields empty columns', () => {
    expect(reshapeBoardConfig({})).toEqual({ id: 0, name: '', type: '', columns: [] });
  });
});
