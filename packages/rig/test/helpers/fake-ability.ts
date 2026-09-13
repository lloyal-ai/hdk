/** A fake ability factory: a manifest, a config schema if asked, and a body that
 *  reads its stored config and refuses when told to — enough to drive the
 *  registry, the descriptors and the settings group without a real ability. */
import { AbilityConfigStoreCtx } from '@lloyal-labs/lloyal-agents';
import type { Ability, AbilityFactory, AbilityManifest } from '@lloyal-labs/lloyal-agents';

export function fakeAbility(opts: {
  name: string;
  /** `required` makes it need stored config to enable. */
  configSchema?: AbilityManifest['configSchema'];
  /** A message means: refuse this config (the factory throws it). */
  refuse?: (config: Record<string, unknown> | undefined) => string | undefined;
  /** Called with the config the factory saw, each time it runs. */
  saw?: (config: Record<string, unknown> | undefined) => void;
}): AbilityFactory {
  const manifest: AbilityManifest = {
    name: opts.name,
    abilityProtocolVersion: '3.0',
    protocol: { name: `${opts.name}_protocol`, useWhen: 'when asked', tools: [`${opts.name}_tool`] },
    configSchema: opts.configSchema,
  };
  const factory: AbilityFactory = Object.assign(
    function* (): Generator<unknown, Ability, unknown> {
      const store = yield* AbilityConfigStoreCtx.expect();
      const config = yield* store.get(opts.name);
      opts.saw?.(config);
      const why = opts.refuse?.(config);
      if (why) throw new Error(why);
      return {
        name: opts.name,
        manifest,
        source: { name: opts.name } as Ability['source'],
        tools: [],
        skill: 'a fake skill',
        configSchema: opts.configSchema,
      };
    } as unknown as () => ReturnType<AbilityFactory>,
    { manifest },
  );
  return factory;
}
