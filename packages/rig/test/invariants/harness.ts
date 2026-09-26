/**
 * The world a rig scenario runs in: a served runner, a real registry and store, the settings group over
 * them, and runs the scenario starts and ends. A run is what a harness's run is to the registry: an
 * operation that took its sources through `participating()` and holds them for its own scope's life.
 *
 * `numberedAbility` is the shape of a real ability: every enable is numbered, and each owns a scope with
 * a teardown the scenario can see — what a pacer or an index would own.
 */
import { call, ensure, spawn, suspend } from 'effection';
import type { Operation, Task } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import { createAbilityRegistry } from '../../src/registry';
import { createInMemoryConfigStore } from '../../src/config-store';
import { makeServedRunner } from '../../src/runner';
import { defineConfig, modelSettings, CONFIG_VERSION } from '../../src/config';
import { settings } from '../../src/settings';
import { participating } from '../../src/participating';
import type { SettingsCommand, SettingsEvent } from '../../src/settings-protocol';
import { AbilityConfigStoreCtx } from '../../src/ability-config';
import type { Ability, AbilityFactory, AbilityManifest, AbilityRegistry } from '../../src/ability-types';

const table = defineConfig({ ...modelSettings, 'sources.outputDir': { yml: 'sources.outputDir', path: true, default: 'reports' } });
type Config = { version: typeof CONFIG_VERSION; sources: { outputDir?: string }; abilities: Record<string, Record<string, unknown>>; model: object };
const origin = { 'sources.outputDir': 'yml' as const };
const identity = { 'sources.outputDir': 'sources.outputDir' as const };

/** A tool that answers which enable made it — what an agent holds after it spread an ability's tools. */
export class EnableTool extends Tool<Record<string, never>> {
  readonly description = 'answers which enable made it';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  constructor(readonly name: string, readonly nth: number) {
    super();
  }
  *execute(_args: Record<string, never>): Operation<{ nth: number }> {
    return { nth: this.nth };
  }
}

export interface Enable {
  /** Which enable, 1 from the first. */
  nth: number;
  /** The config that enable saw. */
  config: Record<string, unknown> | undefined;
}

/**
 * An ability whose every enable is numbered and owns a scope with a teardown: `torn` receives an enable's
 * number when its scope ends. `refuse` makes an enable fail on the config it is handed.
 */
export function numberedAbility(opts: {
  name: string;
  configSchema?: AbilityManifest['configSchema'];
  refuse?: (config: Record<string, unknown> | undefined) => string | undefined;
  built: Enable[];
  torn: number[];
}): AbilityFactory {
  let nth = 0;
  const manifest: AbilityManifest = {
    name: opts.name,
    abilityProtocolVersion: '3.0',
    protocol: { name: `${opts.name}_protocol`, useWhen: 'when asked', tools: [`${opts.name}_tool`] },
    configSchema: opts.configSchema,
  };
  return Object.assign(
    function* (): Generator<unknown, Ability, unknown> {
      const store = yield* AbilityConfigStoreCtx.expect();
      const config = yield* store.get(opts.name);
      const why = opts.refuse?.(config);
      if (why) throw new Error(why);
      const mine = ++nth;
      opts.built.push({ nth: mine, config });
      // What a real ability owns for its life — a pacer, an index — ends when the platform ends its scope.
      yield* ensure(() => { opts.torn.push(mine); });
      return {
        name: opts.name,
        manifest,
        source: { name: opts.name, promptData: () => ({}) } as unknown as Ability['source'],
        tools: [new EnableTool(`${opts.name}_tool`, mine)],
        skill: `skill of enable ${mine}`,
        configSchema: opts.configSchema,
      };
    } as unknown as () => ReturnType<AbilityFactory>,
    { manifest },
  );
}

/** A run the scenario started: the sources it took, and its end. */
export interface ScenarioRun {
  /** What `participating()` handed the run — the handles a harness spreads its agents' tools from. */
  sources: readonly Ability[];
  /** The run ends: its scope closes, and with it the hold it took. */
  end(): Operation<void>;
}

export interface World {
  sent: SettingsEvent[];
  store: ReturnType<typeof createInMemoryConfigStore>;
  registry: AbilityRegistry;
  /** Send one settings command through the group. */
  dispatch(command: SettingsCommand): Operation<'exit' | void>;
  /** Start a run: an operation that takes its sources through `participating()` — minus `excluded`, by name —
   *  and then works until ended. */
  startRun(excluded?: readonly string[]): Operation<ScenarioRun>;
}

export function* world(spec: { abilities: AbilityFactory[]; enable?: string[]; config?: Record<string, Record<string, unknown>> }): Operation<World> {
  const sent: SettingsEvent[] = [];
  const cfg: Config = { version: CONFIG_VERSION, sources: { outputDir: '/out' }, abilities: spec.config ?? {}, model: {} };
  const runner = makeServedRunner<Config, typeof origin>(cfg, { table, origin, sessionOriginMap: identity });
  const store = createInMemoryConfigStore();
  for (const [name, c] of Object.entries(cfg.abilities)) yield* store.set(name, c);
  const registry = yield* createAbilityRegistry({ configStore: store });
  for (const name of spec.enable ?? []) yield* registry.enable(spec.abilities.find((a) => a.manifest!.name === name)!);
  const wire = { *send(e: SettingsEvent): Operation<void> { sent.push(e); } };
  const group = settings({ runner, registry, store, wire, abilities: spec.abilities, config: table });
  return {
    sent, store, registry,
    dispatch: (c) => (group.handlers[c.type] as (c: SettingsCommand) => Operation<'exit' | void>)(c),
    *startRun(excluded = []) {
      let sources: readonly Ability[] = [];
      let taken!: () => void;
      const took = new Promise<void>((resolve) => { taken = resolve; });
      const task: Task<void> = yield* spawn(function* () {
        sources = yield* participating(excluded);   // the hold, in the run's own scope
        taken();
        yield* suspend();                    // …working, until ended
      });
      yield* call(() => took);
      return { sources, *end() { yield* task.halt(); } };
    },
  };
}
