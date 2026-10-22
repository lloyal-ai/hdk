/**
 * The native context a service owns: created with the scope that binds the service and freed with it, and used
 * one unit of work at a time, so two callers' sequences of native calls never interleave on it. Every use is a
 * unit, so nothing reaches the context around the queue. The providers that bind a model of their own compose it.
 *
 * Node-only.
 */
import { createContext } from '@lloyal-labs/sdk/node';
import type { ContextOptions, SessionContext } from '@lloyal-labs/sdk';
import { makePermits } from '@lloyal-labs/lloyal-agents';
import { ensure, resource } from 'effection';
import type { Operation } from 'effection';
import { acquire } from '../acquire';

export interface ServiceContext {
  /** One unit of work on the context, run after the units already queued. */
  run<T>(unit: (ctx: SessionContext) => Operation<T>): Operation<T>;
}

/** The context these options create, owned by the calling scope. */
export function useServiceContext(options: ContextOptions): Operation<ServiceContext> {
  return resource(function* (provide) {
    // Owned from the request: a halt while the model loads still frees the context when it arrives.
    const ctx = yield* acquire(() => createContext(options), (c) => c.dispose());
    const gate = makePermits(1);
    // Registered after the acquisition, so the scope runs it first: the unit running finishes before the context is
    // freed. A unit still queued then finds a freed context, whose calls the binding refuses.
    yield* ensure(() => gate.hold(function* () {}));
    yield* provide({ run: (unit) => gate.hold(() => unit(ctx)) });
  });
}
