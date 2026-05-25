/**
 * Tests for `user-config.ts` — file loader for `~/.config/mcp-alm/config.json`.
 *
 * Covers:
 *   - `getUserConfigPath` precedence (MCP_ALM_CONFIG_DIR > XDG_CONFIG_HOME > homedir default).
 *   - `loadUserConfig` graceful behaviour on missing file, malformed JSON, and schema errors.
 *   - `$`-prefixed comment keys are stripped before strict schema validation.
 *
 * The world-readable warning path (POSIX-only) is intentionally NOT exercised here
 * because the suite must run on Windows CI; it is covered by the integration test
 * suite that doctor.mjs gates on.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getUserConfigPath, loadUserConfig } from './user-config.js';

describe('user-config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `mcp-alm-user-config-spec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    delete process.env['MCP_ALM_CONFIG_DIR'];
    delete process.env['XDG_CONFIG_HOME'];
  });

  afterEach(() => {
    delete process.env['MCP_ALM_CONFIG_DIR'];
    delete process.env['XDG_CONFIG_HOME'];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getUserConfigPath', () => {
    it('honours MCP_ALM_CONFIG_DIR over every other source', () => {
      process.env['MCP_ALM_CONFIG_DIR'] = tmpDir;
      process.env['XDG_CONFIG_HOME'] = '/should-be-ignored';
      expect(getUserConfigPath()).toBe(join(tmpDir, 'config.json'));
    });

    it('falls back to XDG_CONFIG_HOME when MCP_ALM_CONFIG_DIR is unset', () => {
      process.env['XDG_CONFIG_HOME'] = tmpDir;
      expect(getUserConfigPath()).toBe(join(tmpDir, 'mcp-alm', 'config.json'));
    });

    it('falls back to ~/.config/mcp-alm/ when no env override is set', () => {
      const result = getUserConfigPath();
      expect(result).toContain('mcp-alm');
      expect(result).toMatch(/config\.json$/);
    });

    it('treats whitespace-only MCP_ALM_CONFIG_DIR as unset', () => {
      process.env['MCP_ALM_CONFIG_DIR'] = '   ';
      process.env['XDG_CONFIG_HOME'] = tmpDir;
      expect(getUserConfigPath()).toBe(join(tmpDir, 'mcp-alm', 'config.json'));
    });
  });

  describe('loadUserConfig', () => {
    function writeConfig(content: string): void {
      process.env['MCP_ALM_CONFIG_DIR'] = tmpDir;
      writeFileSync(join(tmpDir, 'config.json'), content, 'utf8');
    }

    it('returns {} when the file is absent (no exception)', () => {
      process.env['MCP_ALM_CONFIG_DIR'] = tmpDir;
      expect(loadUserConfig()).toEqual({});
    });

    it('parses a valid config with multiple sections', () => {
      writeConfig(
        JSON.stringify({
          jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.co', token: 'tok-1' },
          gitlab: { baseUrl: 'https://gitlab.example.com/api/v4', token: 'tok-2' },
        }),
      );
      const config = loadUserConfig();
      expect(config.jira?.baseUrl).toBe('https://acme.atlassian.net');
      expect(config.jira?.email).toBe('a@b.co');
      expect(config.gitlab?.token).toBe('tok-2');
      // Unbound sections stay undefined — the loader is sparse by design.
      expect(config.confluence).toBeUndefined();
      expect(config.figma).toBeUndefined();
      expect(config.sonar).toBeUndefined();
    });

    it('strips $-prefixed comment keys before schema validation', () => {
      writeConfig(
        JSON.stringify({
          $schema: 'doc-comment',
          $explanation: 'inline notes',
          jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.co', token: 'tok' },
        }),
      );
      expect(() => loadUserConfig()).not.toThrow();
    });

    it('throws when the file is not valid JSON', () => {
      writeConfig('{ not json');
      expect(() => loadUserConfig()).toThrowError(/not valid JSON/);
    });

    it('throws when an unknown top-level section is present (strict schema)', () => {
      writeConfig(JSON.stringify({ rogue: { token: 'x' } }));
      expect(() => loadUserConfig()).toThrowError(/schema validation/);
    });

    it('throws when baseUrl is not a valid URL', () => {
      writeConfig(
        JSON.stringify({
          jira: { baseUrl: 'not-a-url', email: 'a@b.co', token: 'tok' },
        }),
      );
      expect(() => loadUserConfig()).toThrowError(/schema validation/);
    });

    it('throws when token is an empty string', () => {
      writeConfig(
        JSON.stringify({
          jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.co', token: '' },
        }),
      );
      expect(() => loadUserConfig()).toThrowError(/schema validation/);
    });
  });
});
