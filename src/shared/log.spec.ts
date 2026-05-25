import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from './log.js';

interface CapturedLine {
  ts: string;
  server: string;
  version: string;
  tool?: string;
  correlationId?: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
  msg?: string;
  [key: string]: unknown;
}

function captureStderr(): { lines: CapturedLine[]; restore: () => void } {
  const lines: CapturedLine[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split('\n').filter(Boolean)) {
      lines.push(JSON.parse(line) as CapturedLine);
    }
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore() {
      process.stderr.write = original;
    },
  };
}

describe('log.createLogger', () => {
  let capture: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    capture = captureStderr();
  });
  afterEach(() => {
    capture.restore();
  });

  function firstLine(): CapturedLine {
    return capture.lines[0];
  }

  it('embeds server, version, and ts in every line', () => {
    const log = createLogger({ server: 'mcp-test', version: '9.9.9' });
    log.log({ msg: 'hello' });
    const line = firstLine();
    expect(line.server).toBe('mcp-test');
    expect(line.version).toBe('9.9.9');
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(line.msg).toBe('hello');
  });

  it('timed emits one success line with durationMs + ok=true', async () => {
    const log = createLogger({ server: 'mcp-test', version: '1.0.0' });
    await log.timed({ tool: 'jira.get_issue', correlationId: 'corr-1' }, async () => 'result');
    const line = firstLine();
    expect(line.tool).toBe('jira.get_issue');
    expect(line.correlationId).toBe('corr-1');
    expect(line.ok).toBe(true);
    expect(typeof line.durationMs).toBe('number');
  });

  it('timed propagates errors and logs ok=false with the error message', async () => {
    const log = createLogger({ server: 'mcp-test', version: '1.0.0' });
    await expect(
      log.timed({ tool: 'jira.boom', correlationId: 'corr-2' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const line = firstLine();
    expect(line.ok).toBe(false);
    expect(line.error).toBe('boom');
  });

  it('never writes to stdout — only stderr', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = createLogger({ server: 'mcp-test', version: '1.0.0' });
    log.log({ msg: 'check' });
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('redacts token-like keys at any depth (defense-in-depth)', () => {
    const log = createLogger({ server: 'mcp-test', version: '1.0.0' });
    log.log({
      msg: 'sample',
      // Simulated nested shapes that COULD slip into structured log payloads
      // — current call sites avoid these but the redactor is the safety net.
      details: {
        token: 'super-secret-pat',
        password: 'hunter2',
        headers: { authorization: 'Bearer xyz', Authorization: 'Bearer abc' },
        // benign field should pass through untouched
        repo: 'owner/repo',
      },
    });
    const line = firstLine();
    const details = line['details'] as Record<string, unknown>;
    expect(details['token']).toBe('[Redacted]');
    expect(details['password']).toBe('[Redacted]');
    const headers = details['headers'] as Record<string, unknown>;
    expect(headers['authorization']).toBe('[Redacted]');
    expect(headers['Authorization']).toBe('[Redacted]');
    expect(details['repo']).toBe('owner/repo'); // not redacted — verifies we don't over-redact
  });
});
