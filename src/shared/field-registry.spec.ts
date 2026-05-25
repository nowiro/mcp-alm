/**
 * Unit tests — field registry + value reshape.
 */
import { describe, expect, it, vi } from 'vitest';

import { createJiraFieldRegistry, reshapeFieldValue, type FieldMeta } from './field-registry.js';

function fakeHttp(fields: unknown): { request: <T>(req: { path: string }) => Promise<T> } {
  return {
    async request<T>() {
      return fields as T;
    },
  };
}

describe('createJiraFieldRegistry', () => {
  it('loads + caches fields on first lookup', async () => {
    const http = fakeHttp([
      { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
      {
        id: 'customfield_10042',
        name: 'Story Points',
        custom: true,
        schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' },
      },
    ]);
    const reg = createJiraFieldRegistry(http);
    expect(reg.ready()).toBe(false);
    await reg.load();
    expect(reg.ready()).toBe(true);
    expect(reg.byId('customfield_10042')?.name).toBe('Story Points');
    expect(reg.byName('story points')?.id).toBe('customfield_10042');
  });

  it('reports ready=false and undefined lookups when load fails', async () => {
    const onError = vi.fn();
    const http = {
      async request() {
        throw new Error('403 forbidden');
      },
    };
    const reg = createJiraFieldRegistry(http, { onError });
    await reg.load();
    expect(reg.ready()).toBe(true);
    expect(reg.byId('customfield_10042')).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it('lookup before load triggers async load (best-effort)', async () => {
    const http = fakeHttp([{ id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } }]);
    const reg = createJiraFieldRegistry(http);
    expect(reg.byId('summary')).toBeUndefined(); // not loaded yet
    await reg.load();
    expect(reg.byId('summary')?.name).toBe('Summary');
  });
});

describe('reshapeFieldValue', () => {
  const meta = (overrides: Partial<FieldMeta>): FieldMeta => ({
    id: 'customfield_x',
    name: 'X',
    custom: true,
    type: 'string',
    ...overrides,
  });

  it('returns undefined for null/undefined raw values', () => {
    expect(reshapeFieldValue(meta({}), null)).toBeUndefined();
    expect(reshapeFieldValue(meta({}), undefined)).toBeUndefined();
  });

  it('passes through unknown fields with id="unknown"', () => {
    expect(reshapeFieldValue(undefined, 'foo')).toEqual({
      id: 'unknown',
      name: 'unknown',
      type: 'unknown',
      value: 'foo',
    });
  });

  it('reshapes string field', () => {
    const out = reshapeFieldValue(meta({ type: 'string', name: 'Description' }), 'hello');
    expect(out).toEqual({ id: 'customfield_x', name: 'Description', type: 'string', value: 'hello' });
  });

  it('reshapes number field', () => {
    const out = reshapeFieldValue(meta({ type: 'number', name: 'Story Points' }), 5);
    expect(out?.value).toBe(5);
    expect(out?.type).toBe('number');
  });

  it('reshapes option field to {id, value}', () => {
    const out = reshapeFieldValue(meta({ type: 'option' }), { id: '10500', value: 'High' });
    expect(out?.value).toEqual({ id: '10500', value: 'High' });
  });

  it('reshapes user field to {accountId, displayName}', () => {
    const out = reshapeFieldValue(meta({ type: 'user', name: 'Assignee' }), {
      accountId: 'abc',
      displayName: 'Alice',
      emailAddress: 'a@example.com',
    });
    expect(out?.value).toEqual({ accountId: 'abc', displayName: 'Alice' });
  });

  it('reshapes array<option>', () => {
    const out = reshapeFieldValue(meta({ type: 'array', itemType: 'option', name: 'Components' }), [
      { id: '1', value: 'API' },
      { id: '2', value: 'UI' },
    ]);
    expect(out?.value).toEqual([
      { id: '1', value: 'API' },
      { id: '2', value: 'UI' },
    ]);
    expect(out?.type).toBe('option[]');
  });

  it('reshapes sprint custom field to array<{id, name, state?}>', () => {
    const out = reshapeFieldValue(
      meta({
        type: 'array',
        itemType: 'json',
        schemaCustom: 'com.pyxis.greenhopper.jira:gh-sprint',
        name: 'Sprint',
      }),
      [
        { id: 1, name: 'Sprint 1', state: 'closed' },
        { id: 2, name: 'Sprint 2', state: 'active' },
      ],
    );
    expect(out?.type).toBe('sprint[]');
    expect(out?.value).toEqual([
      { id: 1, name: 'Sprint 1', state: 'closed' },
      { id: 2, name: 'Sprint 2', state: 'active' },
    ]);
  });

  it('reshapes cascading select', () => {
    const out = reshapeFieldValue(meta({ type: 'option-with-child', name: 'Region' }), {
      value: 'EMEA',
      child: { value: 'Poland' },
    });
    expect(out?.type).toBe('cascading');
    expect(out?.value).toEqual({ value: 'EMEA', child: { value: 'Poland' } });
  });

  it('reshapes priority/status to {id, name}', () => {
    const out = reshapeFieldValue(meta({ type: 'priority', name: 'Priority' }), { id: '3', name: 'High' });
    expect(out?.value).toEqual({ id: '3', name: 'High' });
  });

  it('reshapes Tempo Account plugin field', () => {
    const out = reshapeFieldValue(
      meta({
        type: 'any',
        schemaCustom: 'com.tempoplugin.tempo-accounts:accounts.customfield',
        name: 'Account',
      }),
      { id: 42, key: 'ACC-1', name: 'Marketing' },
    );
    expect(out?.type).toBe('tempo-account');
    expect(out?.value).toEqual({ id: '42', key: 'ACC-1', name: 'Marketing' });
  });

  it('reshapes Insight (Assets) plugin field as array', () => {
    const out = reshapeFieldValue(
      meta({
        type: 'array',
        itemType: 'json',
        schemaCustom: 'com.riadalabs.jira.plugin.insight:rlabs-insight-custom-field-cftype',
        name: 'Asset',
      }),
      [
        { id: '1', objectKey: 'SRV-1', label: 'WebServer' },
        { id: '2', objectKey: 'SRV-2', label: 'DBServer' },
      ],
    );
    expect(out?.type).toBe('insight-object[]');
    expect(out?.value).toEqual([
      { id: '1', objectKey: 'SRV-1', label: 'WebServer' },
      { id: '2', objectKey: 'SRV-2', label: 'DBServer' },
    ]);
  });

  it('reshapes Xray Test Type field', () => {
    const out = reshapeFieldValue(
      meta({
        type: 'option',
        schemaCustom: 'com.xpandit.plugins.xray:test-type-custom-field',
        name: 'Test Type',
      }),
      { value: 'Manual' },
    );
    expect(out?.type).toBe('xray-test');
    expect(out?.value).toEqual({ testType: 'Manual' });
  });

  it('reshapes Epic Link as plain key string', () => {
    const out = reshapeFieldValue(
      meta({
        type: 'string',
        schemaCustom: 'com.pyxis.greenhopper.jira:gh-epic-link',
        name: 'Epic Link',
      }),
      'PROJ-100',
    );
    expect(out?.type).toBe('epic-link');
    expect(out?.value).toBe('PROJ-100');
  });
});
