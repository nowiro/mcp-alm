/**
 * server-jira HTTP wiring — integration tests via the server harness.
 *
 * Covers the agile + write tools added in the agile family: input → URL/query
 * construction → reshape → output, with `fetch` stubbed. This is the layer that
 * was previously only typecheck-guaranteed (server-*.ts is coverage-excluded as
 * "pokryta testami integracyjnymi gdy powstaną" — these are those tests).
 */
import { describe, expect, it } from 'vitest';

import { invokeTool, loadJiraTools, makeCtx } from './server-harness.js';

const json = (value: unknown): string => JSON.stringify(value);

describe('server-jira agile read handlers', () => {
  it('jira.list_boards builds the /rest/agile/1.0/board URL with filters and reshapes values', async () => {
    const { out, calls } = await invokeTool('jira.list_boards', { projectKeyOrId: 'PROJ', type: 'scrum' }, [
      {
        status: 200,
        body: json({
          isLast: true,
          values: [
            { id: 12, name: 'PROJ board', type: 'scrum', location: { projectKey: 'PROJ', projectName: 'Project X' } },
          ],
        }),
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/rest/agile/1.0/board');
    expect(calls[0]?.url).toContain('projectKeyOrId=PROJ');
    expect(calls[0]?.url).toContain('type=scrum');
    expect(out).toMatchObject({
      boards: [{ id: 12, name: 'PROJ board', type: 'scrum', projectKey: 'PROJ', projectName: 'Project X' }],
      isLast: true,
    });
  });

  it('jira.list_sprints targets the board and defaults state to active+future', async () => {
    const { out, calls } = await invokeTool('jira.list_sprints', { boardId: 55 }, [
      { status: 200, body: json({ isLast: true, values: [{ id: 9, name: 'Sprint 9', state: 'active' }] }) },
    ]);
    expect(calls[0]?.url).toContain('/rest/agile/1.0/board/55/sprint');
    expect(calls[0]?.url).toContain('state=active'); // active + future joined
    expect(out).toMatchObject({ sprints: [{ id: 9, name: 'Sprint 9', state: 'active' }], isLast: true });
  });

  it('jira.get_sprint_issues uses the offset endpoint and returns reshaped items', async () => {
    const { out, calls } = await invokeTool('jira.get_sprint_issues', { sprintId: 55 }, [
      { status: 200, body: json({ total: 1, issues: [{ id: '1', key: 'ABC-1', fields: { summary: 'Fix it' } }] }) },
    ]);
    expect(calls[0]?.url).toContain('/rest/agile/1.0/sprint/55/issue');
    expect(calls[0]?.url).toContain('startAt=0');
    expect(out).toMatchObject({ items: [{ key: 'ABC-1', summary: 'Fix it' }] });
  });

  it('jira.get_board_config surfaces the estimation field from the configuration payload', async () => {
    const { out } = await invokeTool('jira.get_board_config', { boardId: 12 }, [
      {
        status: 200,
        body: json({
          id: 12,
          name: 'PROJ board',
          type: 'scrum',
          columnConfig: { columns: [{ name: 'To Do', statuses: [{ id: '10000' }] }] },
          estimation: { field: { fieldId: 'customfield_10016', displayName: 'Story Points' } },
        }),
      },
    ]);
    expect(out).toMatchObject({
      id: 12,
      estimationField: { id: 'customfield_10016', name: 'Story Points' },
      columns: [{ name: 'To Do', statusIds: ['10000'] }],
    });
  });
});

describe('server-jira write handler (move_issues_to_sprint, gated)', () => {
  it('is registered only because the harness enables writes + allowlist', async () => {
    const tools = await loadJiraTools();
    expect(tools.some((t) => t.name === 'jira.move_issues_to_sprint')).toBe(true);
  });

  it('dryRun echoes the request body and makes NO upstream call', async () => {
    const { out, calls } = await invokeTool('jira.move_issues_to_sprint', {
      sprintId: 55,
      keys: ['ABC-1', 'ABC-2'],
      dryRun: true,
    });
    expect(calls).toHaveLength(0);
    expect(out).toMatchObject({
      dryRun: true,
      method: 'POST',
      path: '/rest/agile/1.0/sprint/55/issue',
      body: { issues: ['ABC-1', 'ABC-2'] },
    });
  });

  it('real call POSTs the issues and returns an ok summary (204)', async () => {
    const { out, calls } = await invokeTool('jira.move_issues_to_sprint', { sprintId: 55, keys: ['ABC-1'] }, [
      { status: 204 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/rest/agile/1.0/sprint/55/issue');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(String(calls[0]?.init?.body)).toContain('ABC-1');
    expect(out).toMatchObject({ ok: true, sprintId: 55, moved: 1, keys: ['ABC-1'] });
  });

  it('is denied (throws) when the tool is not on MCP_WRITE_ALLOWLIST', async () => {
    const tools = await loadJiraTools();
    const tool = tools.find((t) => t.name === 'jira.move_issues_to_sprint');
    if (!tool) throw new Error('move tool not registered');
    const saved = process.env['MCP_WRITE_ALLOWLIST'];
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.create_issue'; // anything but move
    try {
      await expect(
        tool.handle(tool.inputSchema.parse({ sprintId: 1, keys: ['ABC-1'] }), makeCtx('jira.move_issues_to_sprint')),
      ).rejects.toThrow();
    } finally {
      process.env['MCP_WRITE_ALLOWLIST'] = saved;
    }
  });
});
