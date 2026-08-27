/**
 * The pane's distribution layer — a vanilla zustand store wrapping the core
 * fold. The fold stays pure and framework-free (index.ts); this module owns
 * the SUBSCRIPTION mechanics both renderers share (`/react` binds it with
 * `useStore`; the ink overlay may too):
 *
 * - **Wire gate** — until `config:loaded` says `dev: true`, ONLY that event
 *   folds. Production streams pay one type-check per event and nothing else.
 * - **Stepped repaint** — events fold the moment they arrive, but `rev` (what
 *   renderers subscribe to) advances at most once per {@link EDGE_STEP} for
 *   high-frequency events. Structural events (spawn, done, plan, config)
 *   flush immediately. The timeline's quantized edge and the paint cadence
 *   are the same clock: a token stream never causes per-token renders.
 */
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { createPaneModel, foldEvent, isLive } from './index.js';
import type { DevEvent, PaneModel } from './index.js';

/** The bridge slice the pane needs — structurally `window.harness`, minus the
 *  snapshot method the pane deliberately ignores (it folds live only). */
export interface DevBridge {
  onEvent(cb: (envelope: { ev: DevEvent }) => void): () => void;
  send(command: unknown): void;
}

/** Live-edge quantum, ms — capsules grow and repaints happen on this grid. */
export const EDGE_STEP = 1000;

/** Event types whose arrival repaints immediately — everything a human reads
 *  as "something happened" rather than "the stream is flowing". */
const STRUCTURAL = new Set([
  'config:loaded', 'config:updated', 'ready', 'abilities:state',
  'plan:start', 'query', 'research:start', 'synthesize:start', 'plan',
  'agent:spawn', 'agent:done', 'agent:failed', 'agent:recovered',
  'agent:return', 'agent:tool_call', 'agent:tool_result', 'agent:trace',
  'answer', 'error',
]);

export interface DevStoreState {
  /** The folded model — MUTATED by the fold; renderers key off `rev`. */
  model: PaneModel;
  /** Bumped on the stepped cadence (or immediately for structural events). */
  rev: number;
  /** Monotonic "now" of the last repaint — the timeline's quantized edge. */
  paintedAt: number;
}

export interface DevStore extends StoreApi<DevStoreState> {
  /** Dispatch a command back over the bridge (Settings controls). */
  send(command: unknown): void;
  /** Unsubscribe from the bridge and stop the step timer. */
  destroy(): void;
}

/** One store per bridge, for the LIFETIME of the page. A React remount
 *  (fast refresh, StrictMode, lazy mounting) must REATTACH to the running
 *  fold, not restart it — a fresh store mid-run would miss the wire gate's
 *  `config:loaded` and every event before it (lanes without roles, empty
 *  history — the late-subscriber desync). True late-joins (a fresh page
 *  mid-run) are the driver's seq'd snapshot/replay concern, not the
 *  pane's; on today's contract a reload starts a new session, whose fresh
 *  stream re-opens the gate naturally. */
const STORES = new WeakMap<DevBridge, DevStore>();

export function devStoreFor(bridge: DevBridge): DevStore {
  let store = STORES.get(bridge);
  if (!store) {
    store = createDevStore(bridge);
    STORES.set(bridge, store);
  }
  return store;
}

export function createDevStore(bridge: DevBridge): DevStore {
  const model = createPaneModel();
  const store = createStore<DevStoreState>(() => ({
    model,
    rev: 0,
    paintedAt: performance.now(),
  }));

  let dirty = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paint = (): void => {
    dirty = false;
    store.setState((s) => ({ rev: s.rev + 1, paintedAt: performance.now() }));
  };

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      // While a lane is open the clocks must advance even with no new events
      // (an all-agents-parked stretch is exactly when the countdown matters);
      // idle and completed runs stop repainting.
      if (dirty || isLive(model)) paint();
    }, EDGE_STEP);
  };

  const off = bridge.onEvent(({ ev }) => {
    if (!ev || typeof ev.type !== 'string') return;
    // Truly wire-gated: until config:loaded says dev, fold ONLY that event —
    // a production stream pays one string compare per event, nothing more.
    if (!model.dev && ev.type !== 'config:loaded') return;
    foldEvent(model, ev, performance.now());
    if (!model.dev) return;
    ensureTimer();
    if (STRUCTURAL.has(ev.type)) paint();
    else dirty = true;
  });

  return Object.assign(store, {
    send: (command: unknown) => bridge.send(command),
    destroy: () => {
      off();
      if (timer !== null) { clearInterval(timer); timer = null; }
    },
  });
}
