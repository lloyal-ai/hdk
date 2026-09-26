/**
 * Reading an upload under a ceiling and a deadline.
 *
 * Nothing here knows about Electron or the content plane — it is a stream, a
 * cap and a signal — which is what lets it be tested against a stalled stream
 * instead of a three-minute wait.
 *
 * @category Desktop
 */

/** Over the cap. Separate from a refusal so the client is told which limit. */
export class TooLarge extends Error {}
/** Past the deadline — the transfer, the ingest, or both together. */
export class TooSlow extends Error {}

/**
 * Read the body, refusing AT the cap rather than after it, and giving up the
 * moment the signal says so. The abort is RACED against each read rather than
 * checked between them: a stalled stream is precisely the case where no read
 * resolves. Cancellation is started, never awaited: on a stream whose `read()`
 * is stuck, `cancel()` can be stuck too.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw new TooSlow('the upload was cancelled');
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  let reject!: (e: Error) => void;
  const cancelled = new Promise<never>((_, rej) => { reject = rej; });
  const abort = (): void => reject(new TooSlow('the upload was cancelled'));
  signal.addEventListener('abort', abort, { once: true });

  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), cancelled]);
      if (done) break;
      seen += value.byteLength;
      if (seen > cap) throw new TooLarge(`upload exceeds ${cap} bytes`);
      chunks.push(value);
    }
    // Reaching EOF is not safety: the deadline can pass as the last chunk lands.
    if (signal.aborted) throw new TooSlow('the upload was cancelled');
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  } finally {
    signal.removeEventListener('abort', abort);
  }

  const out = new Uint8Array(seen);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
