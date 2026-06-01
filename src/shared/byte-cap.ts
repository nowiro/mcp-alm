/**
 * Pure helper for head-capping arbitrary upstream text (file contents, raw
 * blobs) before it reaches the LLM.
 *
 * Sibling to `tailBytes` (gitlab-job-log.ts): CI logs are read tail-first (the
 * latest output is what matters), source files head-first (imports / signatures
 * sit up top). Both cap on the UTF-8 byte buffer and re-decode with
 * `fatal: false` so a partial multi-byte sequence at the cut point becomes one
 * U+FFFD rather than throwing.
 */

/** Result shape for {@link headBytes}. */
export interface ByteCapResult {
  /** The (possibly truncated) text. */
  readonly content: string;
  /** Total UTF-8 byte length of the *original* text. */
  readonly totalBytes: number;
  /** UTF-8 byte length of {@link content}. */
  readonly returnedBytes: number;
  /** `true` when the returned content was clipped to the head; `false` otherwise. */
  readonly truncated: boolean;
}

/**
 * Return the first `maxBytes` bytes of `text` measured in UTF-8 bytes.
 *
 * When truncation happens we slice on the UTF-8 byte buffer and re-decode with
 * `fatal: false` (default) so any partial multi-byte sequence at the cut point
 * is replaced with U+FFFD instead of throwing. Callers see one replacement char
 * at most — everything before it is valid UTF-8.
 */
export function headBytes(text: string, maxBytes: number): ByteCapResult {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new Error(`headBytes: maxBytes must be >= 1, got ${maxBytes}`);
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const totalBytes = bytes.byteLength;
  const cap = Math.floor(maxBytes);

  if (totalBytes <= cap) {
    return { content: text, totalBytes, returnedBytes: totalBytes, truncated: false };
  }

  const slice = bytes.subarray(0, cap);
  const content = new TextDecoder('utf-8').decode(slice);
  const returnedBytes = encoder.encode(content).byteLength;
  return { content, totalBytes, returnedBytes, truncated: true };
}
