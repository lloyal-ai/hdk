import { resource } from 'effection';
import type { Operation } from 'effection';
import type { TraceWriter } from './trace-writer';
import type { TraceId } from './trace-types';

/**
 * Open a named trace scope, closed automatically when the caller's scope exits.
 *
 * `scope:open` / `scope:close` are what give a trace its TREE, so a missing
 * close is a malformed tree rather than a missing line. This is a RESOURCE for
 * that reason: Effection documents three ways out of a scope — return, error
 * and HALT — and the previous `{ traceId, close }` shape made closing
 * something each caller had to remember on each of them. They did not: one
 * closed in a `finally`, one closed during setup (so a throw in its drain loop
 * skipped it), and one closed on return and on catch but not on halt. A
 * cancelled run therefore left a scope open exactly when the trace is most
 * worth reading.
 *
 * Same correction, same reason, as `useTraceWriter`: a caller-must-close pair
 * is the shape `resource()` exists to remove.
 *
 * Acquire it BEFORE the things it should contain — teardown runs in reverse,
 * so the close lands after their own cleanup events and those stay inside the
 * scope they belong to.
 *
 * @param writer - Active {@link TraceWriter} to emit events to
 * @param parentTraceId - Trace ID of the enclosing scope, or `null` for root scopes
 * @param name - Human-readable scope label (e.g. `"pool"`, `"tool:search"`)
 * @param meta - Optional key-value metadata attached to the `scope:open` event
 * @returns The allocated `traceId`, for parenting events inside this scope
 *
 * @category Agents
 */
export function useTraceScope(
  writer: TraceWriter,
  parentTraceId: TraceId | null,
  name: string,
  meta?: Record<string, unknown>,
): Operation<TraceId> {
  return resource(function* (provide) {
    const traceId = writer.nextId();
    const ts = performance.now();
    writer.write({ traceId, parentTraceId, ts, type: 'scope:open', name, meta });
    try {
      yield* provide(traceId);
    } finally {
      writer.write({
        traceId: writer.nextId(), parentTraceId: traceId,
        ts: performance.now(),
        type: 'scope:close', name, durationMs: performance.now() - ts,
      });
      writer.flush();
    }
  });
}
