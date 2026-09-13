/**
 * `initializeHarness`: the harness's boot, in `initAgents`'s shape — a
 * caller-scope initializer whose contexts are set in the caller and whose
 * cleanup runs by `ensure`, never a resource.
 *
 * It runs `initAgents`, installs the replay trunk, publishes the Runner's
 * signals for the pool and the pool's defaults (per-token epistemics on a dev
 * boot, a returned agent's branch freed at once), carries the resident
 * context's sequence count when the boot knows it, seeds the config store,
 * creates the registry, enables every declared ability whose required config
 * is present and reports the ones that failed, and establishes the forwarder's
 * subscription BEFORE it returns: a Channel is a Signal underneath and a send
 * with no subscriber is dropped, so the first thing the app said would
 * otherwise be lost. It then says `config:loaded` and `abilities:state` itself
 * — the first two events on the wire, both rig's vocabulary — and hands back
 * `disabled` for the app to report in its own words.
 *
 * It owns the session. The context is owned by whoever made it — the boot, or
 * the served host — and is not disposed here.
 *
 * @category Rig
 */
import { spawn } from 'effection';
import type { Channel, Operation } from 'effection';
import type { Session, SessionContext } from '@lloyal-labs/sdk';
import {
  initAgents, reconstructBranch, WindDown, CancelAgent, Pause, PoolDefaults, NSeqMax,
} from '@lloyal-labs/lloyal-agents';
import type { AbilityConfigStore, AbilityFactory, AbilityRegistry } from '@lloyal-labs/lloyal-agents';
import type { ConfigTable, ConfigOf, OriginOf } from './config';
import { RunnerCtx } from './runner';
import type { Runner } from './runner';
import { createInMemoryConfigStore } from './config-store';
import { createAbilityRegistry, abilityRequiresConfig } from './registry';
import { buildAbilityDescriptors } from './ability-descriptors';
import { configLoaded } from './settings-protocol';

/** What the app composes its parts over. */
export interface Initialized<T extends ConfigTable, E> {
  session: Session;
  /** The agent channel, typed to the app's events: the app's own events keep order with the agents'. */
  wire: Channel<E, void>;
  runner: Runner<ConfigOf<T>, OriginOf<T>>;
  registry: AbilityRegistry;
  store: AbilityConfigStore;
  /** Declared abilities that failed to enable, with the reason, for the app to report in its own words. */
  disabled: { name: string; reason: string }[];
}

export interface InitializeHarnessOpts<T extends ConfigTable> {
  /** The installed ability factories, in enable order. */
  abilities: readonly AbilityFactory[];
  /** The app's `defineConfig` table: the type witness for the Runner's config and provenance. */
  config: T;
  /** The resident context's sequence count, when the boot knows it. */
  nSeqMax?: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function* initializeHarness<T extends ConfigTable, E>(
  ctx: SessionContext,
  events: { send(event: E): void },
  opts: InitializeHarnessOpts<T>,
): Operation<Initialized<T, E>> {
  const runner = (yield* RunnerCtx.expect()) as unknown as Runner<ConfigOf<T>, OriginOf<T>>;
  const { session, events: wire } = yield* initAgents<E>(ctx, {
    traceWriter: runner.traceWriter,
    attachmentStore: runner.attachmentStore,
    disposeContext: false,
  });
  // Replay: the spine rebuilt from the checkpoint is the trunk before any ability registers.
  if (runner.replayCheckpoint) session.trunk = yield* reconstructBranch(runner.replayCheckpoint);

  yield* WindDown.set(runner.windDown);
  yield* CancelAgent.set(runner.cancelAgent);
  yield* Pause.set(runner.pauseRun);
  yield* PoolDefaults.set({ trace: runner.dev, pruneOnReturn: true });
  if (opts.nSeqMax !== undefined) yield* NSeqMax.set(opts.nSeqMax);

  // The forwarder: subscribed here, in the caller's scope, drained on a child.
  const subscription = yield* wire;
  yield* spawn(function* () {
    for (;;) {
      const next = yield* subscription.next();
      if (next.done) return;
      events.send(next.value);
    }
  });

  const store = createInMemoryConfigStore();
  for (const [name, cfg] of Object.entries(runner.config().abilities)) yield* store.set(name, cfg);
  const registry = yield* createAbilityRegistry({ configStore: store });

  const disabled: { name: string; reason: string }[] = [];
  for (const factory of opts.abilities) {
    const name = factory.manifest?.name;
    if (!name) continue;
    if (abilityRequiresConfig(factory)) {
      const cfg = yield* store.get(name);
      if (!cfg || Object.keys(cfg).length === 0) continue; // configurable later; its descriptor says so
    }
    try {
      yield* registry.enable(factory);
    } catch (err) {
      disabled.push({ name, reason: message(err) });
    }
  }

  yield* wire.send(configLoaded(runner) as unknown as E);
  yield* wire.send({ type: 'abilities:state', abilities: yield* buildAbilityDescriptors(registry, store, opts.abilities) } as unknown as E);
  return { session, wire, runner, registry, store, disabled };
}
