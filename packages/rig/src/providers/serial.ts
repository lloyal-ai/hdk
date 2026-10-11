import { ensure, resource, scoped, until } from 'effection';
import type { Operation } from 'effection';

export interface SerialExecutor {
  run<T>(work: () => Operation<T>): Operation<T>;
}

/** Cancelled waiters release their place; an active operation owns its cleanup before the next can enter. */
export function useSerialExecutor(): Operation<SerialExecutor> {
  return resource(function* (provide) {
    let tail = Promise.resolve();
    let closed = false;
    yield* ensure(function* () { closed = true; yield* until(tail); });
    yield* provide({
      run<T>(work: () => Operation<T>): Operation<T> {
        return scoped(function* () {
          if (closed) throw new Error('the service is disposed');
          const previous = tail;
          let release!: () => void;
          const turn = new Promise<void>(resolve => { release = resolve; });
          tail = previous.then(() => turn);
          yield* ensure(() => release());
          yield* until(previous);
          if (closed) throw new Error('the service is disposed');
          return yield* work();
        });
      },
    });
  });
}
