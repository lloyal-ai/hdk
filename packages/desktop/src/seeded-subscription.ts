/**
 * A subscription that is told what it missed first. A renderer that subscribes to the stream late — the
 * dev pane mounts only once the installer has cleared, and by then the harness has said `config:loaded` —
 * would otherwise fold from the middle. The seed is what the engine retained; frames that arrive live while
 * the seed is in flight wait behind it, so the subscriber sees one ordered stream whatever the timing.
 * Transport-free: the preload hands in IPC, a test hands in functions.
 *
 * @category Desktop
 */
export interface SeededSource<F> {
  /** The live stream. Returns the unsubscribe. */
  live(cb: (frame: F) => void): () => void;
  /** What came before, in order. A source that cannot say (no handler on the other side) rejects, and that
   *  reads as an empty seed: the live stream must never be held hostage to it. */
  seed(): Promise<readonly F[]>;
}

export function subscribeSeeded<F>(source: SeededSource<F>, cb: (frame: F) => void): () => void {
  let held: F[] | null = [];   // frames that arrived before the seed; null once the seed has been delivered
  let open = true;
  const off = source.live((frame) => {
    if (!open) return;
    if (held) held.push(frame);
    else cb(frame);
  });
  const deliver = (seed: readonly F[]): void => {
    if (!open || !held) return;
    const waiting = held;
    held = null;
    for (const f of seed) cb(f);
    for (const f of waiting) cb(f);
  };
  source.seed().then(deliver, () => deliver([]));
  return () => {
    open = false;
    held = null;
    off();
  };
}
