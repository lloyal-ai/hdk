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
 * The bridge's answer is what separates a stream it has moved TO from one it
 * has already LEFT: an epoch it declines to answer at is behind us, and its
 * frames are history from then on, so one straggler costs one ask, not a loop.
 * An unreachable snapshot seeds from `initialState`, so a stream never stalls
 * on a bridge that cannot answer.
 *
 * @category Binding
 */

import type { SessionState } from "./session";

/** The view's transport link: 'connecting' at load, 'connected' once the host
 *  is ready, 'lost' when the socket dies under a live view. An in-process
 *  bridge never leaves 'connected'. */
export type WireStatus = "connecting" | "connected" | "lost";

/**
 * What a view shows about whether its harness can take work — derived, never stored.
 *
 * Every word is one the platform already uses: `queued` and `warming` are the session's own,
 * `connecting` and `lost` the transport's, `ready` the frame a harness sends when its bootstrap
 * is done, `ended` what a reaped or died session is.
 */
export type Availability = "connecting" | "queued" | "warming" | "ready" | "ended" | "lost";

/**
 * The one derivation, over the two facts that each answer half the question.
 *
 * Neither fact suffices. `wss()` routes `ready` when the socket binds — BEFORE the host admits —
 * so a reader queued behind other users has a perfectly connected transport and no work being done;
 * the socket can never say "waiting". And the producer announces a terminal phase and then closes,
 * so a view reading the socket alone turns "your session ended" into "the network dropped", which
 * is both wrong and a different remedy. Hence: the session's word wins where it is terminal, the
 * transport's wins where the session is still going.
 */
export function availabilityOf(session: SessionState | null, wire: WireStatus): Availability {
  // A session that is going or gone is the last word: the close that follows is its consequence,
  // not a new fact. Inlined deliberately — as a named export this test reads like "the resources are
  // gone", which `draining` is NOT, and the first caller to need a teardown barrier would reuse it.
  if (session && (session.phase === "draining" || session.phase === "died" || session.phase === "reaped")) return "ended";
  if (wire === "lost") return "lost";
  if (!session || session.phase === "parked") return "connecting";
  if (session.phase === "queued") return "queued";
  if (session.phase === "warming") return "warming";
  return wire === "connected" ? "ready" : "connecting";
}

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
  /** The session plane, when the transport carries one: the host's word on this
   *  session's own lifecycle. Fires the last phase seen at once, then on every
   *  change. Absent where there is no host to report one. */
  onSession?(cb: (state: SessionState) => void): () => void;
  /** Ask for a working harness. What that costs belongs to the placement — a
   *  browser opens a new connection, a desktop shell starts a new engine — so a
   *  view asks and never decides. Absent where the bridge cannot provide one. */
  recover?(): void;
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

  /** Epochs the bridge has told us it is no longer on. Their frames are
   *  history — a replay, a straggler from a stream that has ended — so they
   *  never prompt another ask. */
  const superseded = new Set<number>();

  /** Ask the bridge where the stream stands; seed from its answer and fold what
   *  arrived meanwhile. Each request settles at most once, and only the newest
   *  request may settle. `want` is the epoch a frame announced, when a frame is
   *  what prompted the ask: the bridge either confirms that stream, or names
   *  another — and then `want` is behind us, whatever its identifier says. */
  let request = 0;
  const seedFrom = (want: number | null): void => {
    const mine = ++request;
    seeded = false;
    const settle = (base: S, baseEpoch: number, baseSeq: number): void => {
      if (disposed || mine !== request) return;
      if (want !== null && want !== baseEpoch) superseded.add(want);
      seeded = true;
      state = base;
      epoch = baseEpoch;
      seq = baseSeq;
      const buffered = pending;
      pending = [];
      for (let i = 0; i < buffered.length; i++) {
        const frame = buffered[i]!;
        if (frame.epoch !== epoch) {
          if (superseded.has(frame.epoch)) continue;
          // The stream may have moved on while the snapshot was in flight: this
          // frame and the ones after it belong to another. Ask the bridge which.
          pending = buffered.slice(i);
          seedFrom(frame.epoch);
          return;
        }
        if (frame.seq <= seq) continue;
        seq = frame.seq;
        state = reduce(state, frame.ev);
      }
      notify();
    };
    bridge.requestSnapshot().then(
      (snap) => settle(snap.state, snap.epoch, snap.seq),
      // Nothing to correct us: believe the epoch the frame announced, or stay put.
      () => settle(initialState, want ?? epoch, -1),
    );
  };

  // Subscribe FIRST so no frame is missed between the snapshot's cut and now.
  const off = bridge.onEvent((frame) => {
    if (disposed) return;
    if (!seeded) {
      pending.push(frame);
      return;
    }
    if (frame.epoch !== epoch) {
      if (superseded.has(frame.epoch)) return;
      // A new stream: what was folded is another epoch's. Seed again, for it.
      pending = [frame];
      seedFrom(frame.epoch);
      return;
    }
    fold(frame);
  });
  seedFrom(null);

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
