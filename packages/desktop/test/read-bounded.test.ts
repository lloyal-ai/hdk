/**
 * An upload has to stop for two reasons: too many bytes, and too much time.
 * A signal checked BETWEEN reads is only consulted when a read resolves, and
 * the case that needs a deadline is the one where none does; these drive a
 * stream that never yields, so the failure takes milliseconds to prove.
 */
import { describe, it, expect } from 'vitest';
import { readBounded, TooLarge, TooSlow } from '../src/read-bounded';

function stream(chunks: Uint8Array[] = [], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); },
    cancel() { onCancel?.(); },
  });
}
const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);

describe('readBounded', () => {
  it('a stalled stream is abandoned at the deadline, not waited out', async () => {
    const ctrl = new AbortController();
    let cancelled = false;
    const started = Date.now();
    setTimeout(() => ctrl.abort(), 30);
    await expect(readBounded(stream([bytes(8)], () => { cancelled = true; }), 1024, ctrl.signal)).rejects.toBeInstanceOf(TooSlow);
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
  });

  it('a signal already aborted is refused before a byte is read', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes(8)); } });
    await expect(readBounded(body, 1024, ctrl.signal)).rejects.toBeInstanceOf(TooSlow);
    expect(body.locked).toBe(false);
  });

  it('reaching EOF after the deadline is still a refusal', async () => {
    const ctrl = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(c) { setTimeout(() => { c.close(); ctrl.abort(); }, 20); } });
    await expect(readBounded(body, 1024, ctrl.signal)).rejects.toBeInstanceOf(TooSlow);
  });

  it('the cap refuses DURING the read, without accumulating the body', async () => {
    const ctrl = new AbortController();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(bytes(64)); } });
    await expect(readBounded(body, 128, ctrl.signal)).rejects.toBeInstanceOf(TooLarge);
    expect(pulls).toBeLessThanOrEqual(4);
  });

  it('an upload inside both bounds comes back whole', async () => {
    const ctrl = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes(3)); c.enqueue(bytes(4)); c.close(); } });
    const out = await readBounded(body, 1024, ctrl.signal);
    expect([...out]).toEqual([7, 7, 7, 7, 7, 7, 7]);
  });
});
