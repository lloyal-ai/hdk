import { ensure, resource, scoped } from 'effection';
import type { Operation } from 'effection';
import { makePermits } from '@lloyal-labs/lloyal-agents';

export interface SerialExecutor {
  run<T>(work: () => Operation<T>): Operation<T>;
}

/** One call at a time, through agents' FIFO gate: a caller that leaves while queued gives up its place, and the
 *  owning scope ends only once the running call has, refusing new work from then on. */
export function useSerialExecutor(): Operation<SerialExecutor> {
  return resource(function* (provide) {
    const gate = makePermits(1);
    let closed = false;
    // Closed first, so a caller still queued is refused when its turn comes; the gate taken once is the running
    // call finished, and handed back so those callers can be.
    yield* ensure(function* () { closed = true; yield* gate.acquire(); gate.release(); });
    yield* provide({
      run<T>(work: () => Operation<T>): Operation<T> {
        return scoped(function* () {
          if (closed) throw new Error('the service is disposed');
          yield* gate.acquire();
          yield* ensure(() => gate.release());
          if (closed) throw new Error('the service is disposed');
          return yield* work();
        });
      },
    });
  });
}
