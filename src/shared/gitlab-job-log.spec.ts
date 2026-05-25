/**
 * Unit tests — tailBytes (pure helper for `gitlab.get_job_log`).
 */
import { describe, expect, it } from 'vitest';

import { tailBytes } from './gitlab-job-log.js';

describe('tailBytes', () => {
  it('returns the whole log when shorter than the cap', () => {
    const log = 'small log';
    const result = tailBytes(log, 64);
    expect(result.content).toBe(log);
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(9);
    expect(result.returnedBytes).toBe(9);
  });

  it('returns the whole log when exactly equal to the cap', () => {
    const log = 'a'.repeat(1024); // 1 KB of single-byte chars
    const result = tailBytes(log, 1);
    expect(result.content).toBe(log);
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(1024);
    expect(result.returnedBytes).toBe(1024);
  });

  it('returns the last N bytes when the log exceeds the cap', () => {
    const log = 'a'.repeat(2048) + 'TAIL'; // 2 KB + 4 bytes
    const result = tailBytes(log, 1); // 1 KB cap
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(2052);
    expect(result.returnedBytes).toBe(1024);
    expect(result.content.endsWith('TAIL')).toBe(true);
    expect(result.content.length).toBe(1024);
  });

  it('handles an empty log', () => {
    const result = tailBytes('', 64);
    expect(result.content).toBe('');
    expect(result.totalBytes).toBe(0);
    expect(result.returnedBytes).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('preserves trailing unicode characters intact', () => {
    // Padding + a 4-byte emoji at the very end. The cap is wide enough to keep
    // the emoji fully inside the tail — no replacement chars expected.
    const padding = 'x'.repeat(2000);
    const log = padding + 'ok-end-🔥';
    const result = tailBytes(log, 1); // 1 KB tail
    expect(result.truncated).toBe(true);
    expect(result.content.endsWith('🔥')).toBe(true);
  });

  it('substitutes U+FFFD when the cut lands inside a multi-byte char', () => {
    // Euro sign (€) is 3 bytes in UTF-8 (E2 82 AC). A string of 400 € is 1200
    // bytes long; trimming to the last 1024 keeps 1024 / 3 = 341.33 chars,
    // which means the cut lands inside the 59th € from the end and that
    // codepoint decodes to U+FFFD. The remaining 341 €'s stay intact.
    const euro = '€';
    const log = euro.repeat(400); // 1200 bytes
    const result = tailBytes(log, 1); // 1 KB cap
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(1200);
    expect(result.content.startsWith('�')).toBe(true);
    // The 341 trailing €'s are intact; check the suffix length / content.
    expect(result.content.endsWith(euro.repeat(341))).toBe(true);
  });

  it('still caps when the log is much larger than maxKb', () => {
    const log = 'x'.repeat(100 * 1024); // 100 KB
    const result = tailBytes(log, 4); // 4 KB cap
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(100 * 1024);
    expect(result.returnedBytes).toBe(4 * 1024);
    expect(result.content.length).toBe(4 * 1024);
  });

  it('rejects non-positive maxKb', () => {
    expect(() => tailBytes('hello', 0)).toThrow();
    expect(() => tailBytes('hello', -1)).toThrow();
    expect(() => tailBytes('hello', Number.NaN)).toThrow();
  });
});
