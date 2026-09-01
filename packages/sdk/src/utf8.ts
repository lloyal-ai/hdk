/**
 * UTF-8 boundary splitting for token streams.
 *
 * A BPE token piece is a byte sequence, not a string — a multi-byte character
 * can end one piece and begin the next. Converting each piece to a string
 * independently replaces both halves with U+FFFD. The fix is a value-level
 * fold: hold the incomplete trailing bytes (at most 3 — a character is at most
 * 4 bytes) and emit only up to the last complete character boundary; the held
 * tail completes with the next piece.
 *
 * Pure functions on values. The stateful half — WHERE the tail lives and WHEN
 * it advances — belongs to {@link Branch}: `produceSync` derives text without
 * installing, `commit` installs the successor tail.
 */

const DECODER = new TextDecoder(); // non-fatal: provably-invalid bytes become U+FFFD

const EMPTY = new Uint8Array(0);

/** A byte sequence split at its last complete UTF-8 character boundary. */
export interface Utf8Split {
  /**
   * Everything up to the boundary, decoded. Bytes that can never complete a
   * character (a stray continuation, an invalid lead, a lead followed by a
   * non-continuation) are already known to be junk and decode to U+FFFD here
   * rather than being held forever.
   */
  complete: string;
  /**
   * The trailing bytes of a character still in flight: a valid lead plus any
   * continuations, 0–3 bytes. Always a fresh copy — never a view into the
   * input.
   */
  tail: Uint8Array;
}

/** Total byte count a UTF-8 lead byte promises; 0 for a continuation or invalid lead. */
function seqLen(b: number): number {
  if (b < 0x80) return 1; // ASCII
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 0; // continuation (0x80–0xbf) or invalid lead (0xc0/0xc1, 0xf5–0xff)
}

const isContinuation = (b: number): boolean => (b & 0xc0) === 0x80;

/**
 * Split `bytes` at the last complete UTF-8 character boundary.
 *
 * Only the final 3 bytes can belong to an incomplete character (a complete
 * character is at most 4 bytes), so the scan is O(1): walk back to the last
 * non-continuation byte in that window, read the sequence length its high
 * bits promise, and hold the sequence only when it is a valid prefix that
 * runs past the end. Everything else — including junk — is decided now.
 */
export function splitCompleteUtf8(bytes: Uint8Array): Utf8Split {
  const n = bytes.length;
  let holdFrom = n;

  const windowStart = Math.max(0, n - 3);
  for (let i = n - 1; i >= windowStart; i--) {
    if (isContinuation(bytes[i])) continue; // walk back to this sequence's lead
    const need = seqLen(bytes[i]);
    if (need > n - i) {
      // The lead promises more bytes than remain. Hold it only if what
      // follows is all continuations — otherwise the sequence is already
      // broken and waiting would never mend it.
      let validPrefix = true;
      for (let j = i + 1; j < n; j++) {
        if (!isContinuation(bytes[j])) { validPrefix = false; break; }
      }
      if (validPrefix) holdFrom = i;
    }
    break; // the last lead settles it, whichever way
  }

  return {
    complete: DECODER.decode(bytes.subarray(0, holdFrom)),
    tail: holdFrom === n ? EMPTY : bytes.slice(holdFrom),
  };
}

/** Concatenate two byte sequences. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
