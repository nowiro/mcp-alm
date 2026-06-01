/**
 * Unit tests — headBytes (pure helper for `gitlab.get_file_content`).
 */
import { describe, expect, it } from 'vitest';

import { headBytes } from './byte-cap.js';

describe('headBytes', () => {
  it('returns the whole text when shorter than the cap', () => {
    const text = 'small file';
    const result = headBytes(text, 65_536);
    expect(result.content).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(10);
    expect(result.returnedBytes).toBe(10);
  });

  it('returns the whole text when exactly equal to the cap', () => {
    const text = 'a'.repeat(1024);
    const result = headBytes(text, 1024);
    expect(result.content).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(1024);
    expect(result.returnedBytes).toBe(1024);
  });

  it('returns the first N bytes when the text exceeds the cap', () => {
    const text = 'HEAD' + 'a'.repeat(2048); // 2052 bytes
    const result = headBytes(text, 1024);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(2052);
    expect(result.returnedBytes).toBe(1024);
    expect(result.content.startsWith('HEAD')).toBe(true);
    expect(result.content.length).toBe(1024);
  });

  it('handles an empty text', () => {
    const result = headBytes('', 64);
    expect(result.content).toBe('');
    expect(result.totalBytes).toBe(0);
    expect(result.returnedBytes).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('preserves leading unicode characters intact', () => {
    // A 4-byte emoji at the very front, then padding. The cap keeps the emoji
    // fully inside the head — no replacement chars expected.
    const text = '🔥start-ok' + 'x'.repeat(2000);
    const result = headBytes(text, 1024);
    expect(result.truncated).toBe(true);
    expect(result.content.startsWith('🔥start-ok')).toBe(true);
  });

  it('substitutes U+FFFD when the cut lands inside a multi-byte char', () => {
    // Euro sign (€) is 3 bytes in UTF-8. 400 €'s = 1200 bytes; a 1024-byte head
    // keeps 341 full €'s (1023 bytes) + 1 dangling byte that decodes to U+FFFD.
    const euro = '€';
    const text = euro.repeat(400); // 1200 bytes
    const result = headBytes(text, 1024);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(1200);
    expect(result.content.startsWith(euro.repeat(341))).toBe(true);
    expect(result.content.endsWith('�')).toBe(true);
  });

  it('still caps when the text is much larger than maxBytes', () => {
    const text = 'x'.repeat(100 * 1024); // 100 KB
    const result = headBytes(text, 4 * 1024); // 4 KB cap
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(100 * 1024);
    expect(result.returnedBytes).toBe(4 * 1024);
    expect(result.content.length).toBe(4 * 1024);
  });

  it('rejects non-positive maxBytes', () => {
    expect(() => headBytes('hello', 0)).toThrow();
    expect(() => headBytes('hello', -1)).toThrow();
    expect(() => headBytes('hello', Number.NaN)).toThrow();
  });
});
