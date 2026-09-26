/**
 * The engine's half of a desktop shell's ingress: bytes in, a root descriptor
 * back, over the Electron `utilityProcess` channel the engine is forked on.
 *
 * It runs in the engine rather than in the window process because the engine
 * is the content store's single WRITER — the shell reads blobs off disk with
 * no lock, which is sound only while one process writes them. Electron-free
 * by design: this is the terminal binary's side, and it must not depend on
 * `electron`; the channel is taken structurally, the same one
 * `@lloyal-labs/binding`'s `ipc()` uses, which ignores every frame that is not
 * a `command`, so these ride alongside without disturbing it.
 *
 * @category Runtime
 */
import type { ContentIngress } from '@lloyal-labs/media';

interface ParentPort {
  postMessage(m: unknown): void;
  on(e: 'message', cb: (ev: { data: unknown }) => void): void;
  off?(e: 'message', cb: (ev: { data: unknown }) => void): void;
  removeListener?(e: 'message', cb: (ev: { data: unknown }) => void): void;
  start?(): void;
}

/** What the shell sends: bytes to admit, or a cancel of one still in flight. */
export type IngestRequest =
  | { t: 'ingest'; id: number; bytes: Uint8Array }
  | { t: 'ingestCancel'; id: number };

/** What the engine answers: the root the store committed, or why it did not. */
export type IngestReply =
  | { t: 'ingested'; id: number; root: unknown }
  | { t: 'ingestFailed'; id: number; error: string };

/**
 * Answer the shell's ingest requests until the returned disposer is called.
 * A no-op without a parent: a terminal has no renderer to serve.
 *
 * A cancel is not advisory. The shell's deadline can only mean something if it
 * reaches the work, so each request holds an `AbortController` and the ingress
 * is given its signal — otherwise a timed-out upload would go on decoding for
 * a window that stopped waiting.
 */
export function serveIngest(ingress: ContentIngress): () => void {
  const pp = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (!pp) return () => {};
  const inflight = new Map<number, AbortController>();

  const onMessage = (ev: { data: unknown }): void => {
    const m = ev.data as Partial<IngestRequest>;
    if (typeof m?.id !== 'number') return;
    if (m.t === 'ingestCancel') {
      inflight.get(m.id)?.abort();
      return;
    }
    if (m.t !== 'ingest' || !m.bytes) return;
    const { id, bytes } = m as Extract<IngestRequest, { t: 'ingest' }>;
    const ctrl = new AbortController();
    inflight.set(id, ctrl);
    void ingress
      .ingest(bytes, ctrl.signal)
      .then((root) => pp.postMessage({ t: 'ingested', id, root } satisfies IngestReply))
      .catch((err: unknown) =>
        pp.postMessage({
          t: 'ingestFailed',
          id,
          error: err instanceof Error ? err.message : 'ingest failed',
        } satisfies IngestReply),
      )
      .finally(() => inflight.delete(id));
  };

  pp.on('message', onMessage);
  pp.start?.();
  return () => { (pp.off ?? pp.removeListener)?.call(pp, 'message', onMessage); };
}
