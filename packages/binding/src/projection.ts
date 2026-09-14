/**
 * The projection: a view's fold of a harness's events, connected to a bridge.
 *
 * A **bridge** is what a renderer holds: events down as `{ epoch, seq, ev }`
 * frames, commands up, and one snapshot — the folded state as of a frame — so
 * a view that mounts late (a remount, a reload, a second window) seeds from
 * the snapshot and folds only what came after. The wire's status and the
 * content plane's origin ride on it when the transport has them.
 *
 * `connectProjection` is the subscribe-first, buffer, seed-by-`seq` mechanics
 * every target used to carry in its own store, framework-free: subscribe
 * before asking for the snapshot so no frame is missed; buffer until it lands;
 * fold the buffered frames newer than the cut; drop a frame at or below the
 * seen `seq`. A frame from another `epoch` — a new stream behind the same
 * bridge — asks for the snapshot again, so the fold never mixes two streams.
 * An unreachable snapshot seeds from `initialState`, so a stream never stalls
 * on a bridge that cannot answer.
 *
 * @category Binding
 */

/** The view's transport link: 'connecting' at load, 'connected' once the host
 *  is ready, 'lost' when the socket dies under a live view. An in-process
 *  bridge never leaves 'connected'. */
export type WireStatus = "connecting" | "connected" | "lost";

/** One event as a bridge delivers it: numbered within its stream. `epoch`
 *  names the stream (a connection, an engine's lifetime); `seq` orders frames
 *  within it. Two frames compare only within one epoch. */
export interface Frame<E> {
  epoch: number;
  seq: number;
  ev: E;
}

/** The folded state as of a frame — what a late subscriber seeds from. */
export interface Snapshot<S> {
  state: S;
  epoch: number;
  seq: number;
}

export interface Bridge<E, C, S> {
  /** Subscribe to frames as they arrive. Returns the unsubscribe. */
  onEvent(cb: (frame: Frame<E>) => void): () => void;
  /** Send a command up to the harness. */
  send(command: C): void;
  /** The folded state as of the last frame delivered, and that frame's place. */
  requestSnapshot(): Promise<Snapshot<S>>;
  /** Transport status, when the bridge has a droppable link. Fires the current
   *  status at once, then on every change. Absent on an in-process bridge. */
  onStatus?(cb: (status: WireStatus) => void): () => void;
  /** The origin of the content plane — where bytes live — or absent when the
   *  bridge has no plane. */
  contentOrigin?(): string;
}

export interface Projection<S> {
  /** The folded state now — the same reference until the next fold. */
  getSnapshot(): S;
  /** Called after every fold. Returns the unsubscribe. */
  subscribe(cb: (state: S) => void): () => void;
  /** Detach from the bridge; a snapshot that lands afterwards is discarded. */
  dispose(): void;
}

export function connectProjection<E, C, S>(
  bridge: Bridge<E, C, S>,
  initialState: S,
  reduce: (state: S, ev: E) => S,
): Projection<S> {
  let state = initialState;
  let epoch = -1;
  let seq = -1;
  let seeded = false;
  let disposed = false;
  let pending: Frame<E>[] = [];
  const listeners = new Set<(state: S) => void>();

  const notify = (): void => {
    for (const cb of listeners) cb(state);
  };

  const fold = (frame: Frame<E>): void => {
    if (frame.seq <= seq) return;
    seq = frame.seq;
    state = reduce(state, frame.ev);
    notify();
  };

  /** Ask the bridge where the stream stands; seed from its answer and fold
   *  what arrived meanwhile. Each request settles at most once, and only
   *  the newest request may settle: a frame from a later epoch supersedes it. */
  let request = 0;
  const seedFrom = (): void => {
    const mine = ++request;
    seeded = false;
    bridge.requestSnapshot().then(
      (snap) => seed(mine, snap.state, snap.epoch, snap.seq),
      () => seed(mine, initialState, epoch, -1),
    );
  };

  const seed = (mine: number, base: S, baseEpoch: number, baseSeq: number): void => {
    if (disposed || mine !== request) return;
    seeded = true;
    state = base;
    epoch = baseEpoch;
    seq = baseSeq;
    const buffered = pending;
    pending = [];
    for (const frame of buffered) {
      if (frame.epoch !== epoch) {
        // The stream moved on while the snapshot was in flight: this frame and
        // the ones after it belong to the new stream. Seed again from there.
        pending = buffered.slice(buffered.indexOf(frame));
        epoch = frame.epoch;
        seedFrom();
        return;
      }
      if (frame.seq <= seq) continue;
      seq = frame.seq;
      state = reduce(state, frame.ev);
    }
    notify();
  };

  // Subscribe FIRST so no frame is missed between the snapshot's cut and now.
  const off = bridge.onEvent((frame) => {
    if (disposed) return;
    if (!seeded) {
      pending.push(frame);
      return;
    }
    if (frame.epoch !== epoch) {
      // A new stream: what was folded is another epoch's. Seed again.
      epoch = frame.epoch;
      pending = [frame];
      seedFrom();
      return;
    }
    fold(frame);
  });
  seedFrom();

  return {
    getSnapshot: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose() {
      disposed = true;
      off();
      listeners.clear();
      pending = [];
    },
  };
}
