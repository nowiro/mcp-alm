import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmationError, WriteDeniedError } from './errors.js';
import {
  assertDestructiveAllowed,
  assertResourceConfirmation,
  assertWriteAllowed,
  isWriteEnabled,
} from './write-guard.js';

function clearEnvironment(): void {
  delete process.env['MCP_WRITE_ENABLED'];
  delete process.env['MCP_WRITE_ALLOWLIST'];
  delete process.env['MCP_DESTRUCTIVE_ALLOWLIST'];
  delete process.env['MCP_DESTRUCTIVE_CONFIRM'];
}

describe('write-guard tier 1 (mutating)', () => {
  beforeEach(clearEnvironment);
  afterEach(clearEnvironment);

  it('defaults to disabled', () => {
    expect(isWriteEnabled()).toBe(false);
  });

  it('isWriteEnabled is case-insensitive on the flag', () => {
    process.env['MCP_WRITE_ENABLED'] = 'TRUE';
    expect(isWriteEnabled()).toBe(true);
  });

  it('denies when MCP_WRITE_ENABLED is absent', () => {
    expect(() => {
      assertWriteAllowed('jira.create_issue');
    }).toThrow(WriteDeniedError);
  });

  it('denies when enabled but allowlist is empty (deny-all default)', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    // No MCP_WRITE_ALLOWLIST — must NOT open every write tool.
    expect(() => {
      assertWriteAllowed('jira.create_issue');
    }).toThrow(WriteDeniedError);
  });

  it('denies when tool name not on the allowlist', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'github.create_issue';
    expect(() => {
      assertWriteAllowed('jira.create_issue');
    }).toThrow(WriteDeniedError);
  });

  it('allows when tool name is on the allowlist', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.create_issue,github.create_pr';
    expect(() => {
      assertWriteAllowed('jira.create_issue');
    }).not.toThrow();
  });
});

describe('write-guard tier 2 (destructive)', () => {
  beforeEach(clearEnvironment);
  afterEach(clearEnvironment);

  it('denies destructive even if tier 1 is fully open', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.delete_issue';
    // MCP_DESTRUCTIVE_* are not set — must still throw.
    expect(() => {
      assertDestructiveAllowed('jira.delete_issue', 'token');
    }).toThrow(WriteDeniedError);
  });

  it('denies when tool name not on the destructive allowlist', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_ALLOWLIST'] = 'jira.delete_attachment';
    process.env['MCP_DESTRUCTIVE_CONFIRM'] = 'long-enough-secret-1234';
    expect(() => {
      assertDestructiveAllowed('jira.delete_issue', 'long-enough-secret-1234');
    }).toThrow(WriteDeniedError);
  });

  it('denies when confirm token does not match', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_CONFIRM'] = 'long-enough-secret-1234';
    expect(() => {
      assertDestructiveAllowed('jira.delete_issue', 'wrong-but-same-length-x');
    }).toThrow(WriteDeniedError);
  });

  it('denies when confirm token is missing entirely', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_CONFIRM'] = 'long-enough-secret-1234';
    expect(() => {
      assertDestructiveAllowed('jira.delete_issue', undefined);
    }).toThrow(WriteDeniedError);
  });

  it('denies when MCP_DESTRUCTIVE_CONFIRM is empty (operator footgun)', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_CONFIRM'] = '';
    expect(() => {
      assertDestructiveAllowed('jira.delete_issue', '');
    }).toThrow(WriteDeniedError);
  });

  it('denies when MCP_DESTRUCTIVE_CONFIRM is too short (< 16 chars)', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_CONFIRM'] = 'short';
    expect(() => {
      assertDestructiveAllowed('jira.delete_issue', 'short');
    }).toThrow(WriteDeniedError);
  });

  it('allows when all three gates pass', () => {
    process.env['MCP_WRITE_ENABLED'] = 'true';
    process.env['MCP_WRITE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_ALLOWLIST'] = 'jira.delete_issue';
    process.env['MCP_DESTRUCTIVE_CONFIRM'] = 'long-enough-secret-1234';
    expect(() => {
      assertDestructiveAllowed('jira.delete_issue', 'long-enough-secret-1234');
    }).not.toThrow();
  });
});

describe('write-guard tier 3 (resource-name confirmation)', () => {
  const TOOL = 'confluence.delete_page';
  const NAME = 'Quarterly Roadmap 2026';

  it('allows when provided name matches the actual name exactly', () => {
    expect(() => {
      assertResourceConfirmation(TOOL, NAME, NAME);
    }).not.toThrow();
  });

  it('denies when provided name is undefined', () => {
    expect(() => {
      assertResourceConfirmation(TOOL, NAME, undefined);
    }).toThrow(ConfirmationError);
  });

  it('denies when provided name is empty string', () => {
    expect(() => {
      assertResourceConfirmation(TOOL, NAME, '');
    }).toThrow(ConfirmationError);
  });

  it('denies when provided name differs by case (case-sensitive)', () => {
    expect(() => {
      assertResourceConfirmation(TOOL, NAME, NAME.toLowerCase());
    }).toThrow(ConfirmationError);
  });

  it('denies when provided name has leading/trailing whitespace (no trimming)', () => {
    expect(() => {
      assertResourceConfirmation(TOOL, NAME, ` ${NAME} `);
    }).toThrow(ConfirmationError);
  });

  it('denies when provided name is a strict prefix of the actual name', () => {
    expect(() => {
      assertResourceConfirmation(TOOL, NAME, 'Quarterly Roadmap');
    }).toThrow(ConfirmationError);
  });

  it('refuses when the actual resource name is empty (safety bail-out)', () => {
    expect(() => {
      assertResourceConfirmation(TOOL, '', 'whatever');
    }).toThrow(ConfirmationError);
  });

  it('error message includes the expected name for the agent to echo', () => {
    expect(() => {
      assertResourceConfirmation(TOOL, NAME, undefined);
    }).toThrow(new RegExp(NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('error carries the tool name and code -32009 for downstream routing', () => {
    let caught: unknown;
    try {
      assertResourceConfirmation(TOOL, NAME, 'wrong');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfirmationError);
    expect((caught as ConfirmationError).tool).toBe(TOOL);
    expect((caught as ConfirmationError).code).toBe(-32_009);
  });
});
