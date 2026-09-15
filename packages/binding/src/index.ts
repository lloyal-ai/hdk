/**
 * @lloyal-labs/binding — the harness's headless interface.
 *
 * A harness exposes its work through two primitives: an `EventBus<WorkflowEvent>`
 * going *down* (events) and a command dispatch going *up*. That pair IS the
 * harness's headless interface; a *binding* is a transport of it — in-process
 * (Ink), one-way JSONL, the `parentPort`-else-`fork` bridge, or (later) wss.
 *
 * This module is the isomorphic core: the event bus, the wire frame, and the
 * projection a view folds over a bridge. The Node transports live in
 * `@lloyal-labs/binding/node`; the browser side of `wss` in `@lloyal-labs/binding/web`.
 */

export { connectProjection, availabilityOf } from "./projection";
export type { Bridge, Frame, Snapshot, Projection, WireStatus, Availability } from "./projection";
export type { SessionState, SessionFrame } from "./session";
import type { SessionFrame } from "./session";

export interface EventBus<T> {
  send(event: T): void;
  subscribe(handler: (event: T) => void): () => void;
}

/**
 * Minimal replay-to-first-subscriber event bus. Buffers while no subscriber
 * exists; the FIRST subscriber synchronously drains the buffer, then live events
 * stream as they arrive. Later subscribers get only live events. Plain JS — no
 * framework — so callers bridge it to any UI/transport, and `send` is safe from
 * non-generator callbacks.
 */
export function createBus<T>(): EventBus<T> {
  let buffer: T[] | null = [];
  const subscribers = new Set<(event: T) => void>();

  return {
    send(event: T): void {
      if (buffer !== null) {
        // No subscriber yet — buffer and wait.
        buffer.push(event);
        return;
      }
      for (const handler of subscribers) handler(event);
    },
    subscribe(handler: (event: T) => void): () => void {
      subscribers.add(handler);
      if (buffer !== null) {
        // First subscriber ever — drain the buffer synchronously, then flip to
        // live mode forever (no second-race window).
        const drained = buffer;
        buffer = null;
        for (const event of drained) handler(event);
      }
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}

/**
 * The **run-plane** wire frame the bidirectional binding transports carry — a closed,
 * JSON-serializable union. `E`/`C` are the harness's own event/command unions; the
 * binding treats them as opaque payload and never inspects their semantics. This is
 * the *harness-authored* plane: a harness only ever emits `event`/`ready` and receives
 * `command`. (The one-way NDJSON transport emits raw events with no envelope/`ready`.)
 *
 * The gateway-authored **session plane** is deliberately NOT a member here — see
 * {@link SessionFrame} in `./session`: it is authored by the box gateway, not the
 * harness, and only exists over the remote (wss) cut, so local bindings never see it.
 */
export type BindingFrame<E = unknown, C = unknown> =
  | { t: "event"; payload: E }
  | { t: "command"; payload: C }
  | { t: "ready" };

/**
 * The **wss-only** routing wrapper: every remote frame is session-addressed so the
 * protocol never bakes in `connection ≡ Session`. The MVP carries one fixed `sessionId`
 * per connection; multi-Session routing reuses the same shape. Local bindings do not use
 * this — routing is a wss concern.
 */
export type RoutedBindingFrame<E = unknown, C = unknown> = {
  sessionId: string;
  frame: BindingFrame<E, C> | SessionFrame;
};
