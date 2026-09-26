/**
 * A command signal that buffers until its first consumer subscribes.
 *
 * A binding dispatches inbound commands from the moment it mounts, but the
 * harness's command loop arms only once the session has booted — and an
 * Effection Signal is hot, so anything sent in that window would vanish. The
 * same replay-to-first-consumer contract the event bus keeps (`createBus`),
 * pointed the other way. First-consumer-only by design: the harness is the
 * one reader.
 *
 * @category Rig
 */
import { createSignal } from 'effection';
import type { Signal } from 'effection';

export function bufferedCommandSignal<T>(): Signal<T, void> {
  const inner = createSignal<T, void>();
  let buffer: T[] | null = [];
  return {
    send(value: T): void {
      if (buffer !== null) buffer.push(value);
      else inner.send(value);
    },
    close: inner.close,
    *[Symbol.iterator]() {
      const subscription = yield* inner;
      if (buffer !== null) {
        // Subscribed — drain into the live subscription (it queues between
        // next() calls), then flip to passthrough forever.
        const drained = buffer;
        buffer = null;
        for (const value of drained) inner.send(value);
      }
      return subscription;
    },
  };
}
