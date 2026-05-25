/**
 * Pure helpers for capping GitLab CI job traces.
 *
 * `gitlab.get_job_log` downloads the full trace from GitLab (text/plain) and
 * then trims it to the last `tail_kb` kilobytes. The trim happens here — kept
 * free of I/O so it stays trivial to unit-test for unicode edge cases.
 */

/** Result shape for {@link tailBytes}. */
export interface TailBytesResult {
  /** The (possibly truncated) log content. */
  readonly content: string;
  /** Total UTF-8 byte length of the *original* log. */
  readonly totalBytes: number;
  /** UTF-8 byte length of {@link content}. */
  readonly returnedBytes: number;
  /** `true` when the returned content was clipped to the tail; `false` otherwise. */
  readonly truncated: boolean;
}

const BYTES_PER_KB = 1024;

/**
 * Return the last `maxKb` kilobytes of `log` measured in UTF-8 bytes.
 *
 * When truncation happens we slice on the UTF-8 byte buffer and re-decode with
 * `fatal: false` so any partial multi-byte sequence at the cut point is
 * replaced with U+FFFD rather than throwing. Callers see one replacement char
 * at most — the rest of the tail is valid UTF-8.
 */
export function tailBytes(log: string, maxKb: number): TailBytesResult {
  if (!Number.isFinite(maxKb) || maxKb < 1) {
    throw new Error(`tailBytes: maxKb must be >= 1, got ${maxKb}`);
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(log);
  const totalBytes = bytes.byteLength;
  const cap = Math.floor(maxKb) * BYTES_PER_KB;

  if (totalBytes <= cap) {
    return {
      content: log,
      totalBytes,
      returnedBytes: totalBytes,
      truncated: false,
    };
  }

  const slice = bytes.subarray(totalBytes - cap);
  // `fatal: false` (default) substitutes U+FFFD for a partial leading codepoint
  // instead of throwing — exactly what we want for a tail cut mid-character.
  const decoder = new TextDecoder('utf-8');
  const content = decoder.decode(slice);
  const returnedBytes = encoder.encode(content).byteLength;
  return {
    content,
    totalBytes,
    returnedBytes,
    truncated: true,
  };
}
