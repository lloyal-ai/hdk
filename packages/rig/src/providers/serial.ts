import { ensure, resource } from 'effection';
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
    const refuseOnceClosed = (): void => { if (closed) throw new Error('the service is disposed'); };
    // Closed first, so a caller still queued is refused when its turn comes; the gate held once is the running
    // call finished, and given back so those callers can be.
    yield* ensure(function* () { closed = true; yield* gate.hold(function* () {}); });
    yield* provide({
      *run<T>(work: () => Operation<T>): Operation<T> {
        refuseOnceClosed();
        return yield* gate.hold(function* () {
          refuseOnceClosed();
          return yield* work();
        });
      },
    });
  });
}
