/**
 * The wire: the agent channel, typed to the application's event union. What
 * `initializeHarness` hands back as `wire`, for the parts that are handed the
 * initializer's result, and this accessor for the ones that are not (a
 * framework-facing algorithm that sends its own phase events). The one cast.
 *
 * @category Rig
 */
import type { Channel, Operation } from 'effection';
import { Events } from '@lloyal-labs/lloyal-agents';

export function* useWire<E>(): Operation<Channel<E, void>> {
  return (yield* Events.expect()) as unknown as Channel<E, void>;
}
