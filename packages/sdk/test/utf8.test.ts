/**
 * UTF-8 boundary splitting — the pure core, then the Branch protocol on top.
 *
 * The property under test: for ANY chunking of a valid byte stream, the
 * held-tail fold emits exactly the original text, every emission is whole
 * characters, and the tail never exceeds 3 bytes. Bytes that can never
 * complete a character decode to U+FFFD immediately rather than being held.
 */
import { describe, expect, it } from 'vitest';
import { splitCompleteUtf8, concatBytes } from '../src/utf8';
import { Branch } from '../src/Branch';
import { MockSessionContext } from '../src/testing.js';

const ENC = new TextEncoder();

// 1-, 2-, 3- and 4-byte characters, mixed with ASCII.
const CORPUS = 'a ÷ b ✅ 📋 → é 한 𐍈 end\n';
const CORPUS_BYTES = ENC.encode(CORPUS);

/** Run `bytes` through the held-tail fold in chunks of the given widths. */
function stream(bytes: Uint8Array, widths: number[]): string {
  let held: Uint8Array = new Uint8Array(0);
  let out = '';
  let at = 0;
  for (const w of widths) {
    const { complete, tail } = splitCompleteUtf8(concatBytes(held, bytes.subarray(at, at + w)));
    expect(tail.length).toBeLessThanOrEqual(3);
    out += complete;
    held = tail;
    at += w;
  }
  expect(at).toBe(bytes.length);
  expect(held.length).toBe(0); // the corpus ends on a character boundary
  return out;
}

describe('splitCompleteUtf8 — the fold reproduces the stream under any chunking', () => {
  it('byte-by-byte (every boundary torn)', () => {
    expect(stream(CORPUS_BYTES, Array(CORPUS_BYTES.length).fill(1))).toBe(CORPUS);
  });

  it('every two-chunk split', () => {
    const n = CORPUS_BYTES.length;
    for (let k = 1; k < n; k++) {
      expect(stream(CORPUS_BYTES, [k, n - k])).toBe(CORPUS);
    }
  });

  it('every fixed width from 1 to 7', () => {
    const n = CORPUS_BYTES.length;
    for (let w = 1; w <= 7; w++) {
      const widths: number[] = [];
      for (let at = 0; at < n; at += w) widths.push(Math.min(w, n - at));
      expect(stream(CORPUS_BYTES, widths)).toBe(CORPUS);
    }
  });

  it('whole input at once is the identity', () => {
    const { complete, tail } = splitCompleteUtf8(CORPUS_BYTES);
    expect(complete).toBe(CORPUS);
    expect(tail.length).toBe(0);
  });
});

describe('splitCompleteUtf8 — junk is decided now, never held', () => {
  it('a lone continuation byte becomes U+FFFD', () => {
    const { complete, tail } = splitCompleteUtf8(new Uint8Array([0x80]));
    expect(complete).toBe('�');
    expect(tail.length).toBe(0);
  });

  it('an invalid lead (0xf5) becomes U+FFFD', () => {
    const { complete, tail } = splitCompleteUtf8(new Uint8Array([0xf5]));
    expect(complete).toBe('�');
    expect(tail.length).toBe(0);
  });

  it('a lead followed by a non-continuation is broken, not incomplete', () => {
    // 0xe2 promises 3 bytes; 'A' is not a continuation. Waiting cannot mend it.
    const { complete, tail } = splitCompleteUtf8(new Uint8Array([0xe2, 0x41]));
    expect(complete).toBe('�A');
    expect(tail.length).toBe(0);
  });

  it('a stray continuation after a complete character decodes beside it', () => {
    const { complete, tail } = splitCompleteUtf8(concatBytes(ENC.encode('é'), new Uint8Array([0x80])));
    expect(complete).toBe('é�');
    expect(tail.length).toBe(0);
  });

  it('a genuinely incomplete character IS held, and completes', () => {
    // '€' is e2 82 ac.
    const first = splitCompleteUtf8(new Uint8Array([0x61, 0xe2, 0x82]));
    expect(first.complete).toBe('a');
    expect(Array.from(first.tail)).toEqual([0xe2, 0x82]);
    const second = splitCompleteUtf8(concatBytes(first.tail, new Uint8Array([0xac])));
    expect(second.complete).toBe('€');
    expect(second.tail.length).toBe(0);
  });
});

describe('Branch produce/commit — text is boundary-aligned, tail advances on commit', () => {
  // 📋 is f0 9f 93 8b — torn across two token pieces.
  const PIECES: Record<number, Uint8Array> = {
    1: new Uint8Array([0xf0, 0x9f]),
    2: new Uint8Array([0x93, 0x8b]),
  };

  function tornCtx(): { ctx: MockSessionContext; next: (t: number) => void } {
    const ctx = new MockSessionContext();
    ctx.tokenToBytes = (t: number) => PIECES[t] ?? ENC.encode(`t${t}`);
    let current = 1;
    ctx._branchSample = () => current;
    return { ctx, next: (t: number) => { current = t; } };
  }

  it('emits nothing for the torn half, the whole character on completion', async () => {
    const { ctx, next } = tornCtx();
    const b = Branch.create(ctx, 0);

    const p1 = b.produceSync();
    expect(p1.text).toBe(''); // half a character is not text yet
    await b.commit(p1.token);

    next(2);
    const p2 = b.produceSync();
    expect(p2.text).toBe('📋'); // completed by the second piece
  });

  it('produce is a pure observation — repeated calls do not advance the tail', async () => {
    const { ctx } = tornCtx();
    const b = Branch.create(ctx, 0);

    expect(b.produceSync().text).toBe('');
    expect(b.produceSync().text).toBe(''); // same answer, no double-advance
  });

  it('the batched commit advances every branch tail (the agent-pool path)', async () => {
    const { BranchStore } = await import('../src/BranchStore');
    const { ctx, next } = tornCtx();
    const store = new BranchStore(ctx);
    const a = Branch.create(ctx, 0);
    const b = Branch.create(ctx, 0);

    const pa = a.produceSync();
    const pb = b.produceSync();
    await store.commit([[a, pa.token], [b, pb.token]]);

    next(2);
    expect(a.produceSync().text).toBe('📋');
    expect(b.produceSync().text).toBe('📋');
  });

  it('a fork continues the parent stream mid-character', async () => {
    const { ctx, next } = tornCtx();
    const b = Branch.create(ctx, 0);
    await b.commit(b.produceSync().token); // parent holds [f0 9f]

    const child = b.forkSync({ cloneLogits: false });
    next(2);
    expect(child.produceSync().text).toBe('📋'); // child completes it
  });
});
