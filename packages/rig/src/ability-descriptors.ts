/**
 * View-ready descriptors for every INSTALLED ability — the ONE builder every
 * harness emits `abilities:state` from, promoted out of the templates so no
 * scaffold re-implements it (and none can forget the redaction: config
 * values NEVER leave this module, only key-presence).
 *
 * Enabled abilities come from the registry; the rest come straight off each
 * factory's static manifest (that is why the manifest rides the factory —
 * readable before enable), `enabled: false`, so a surface can offer
 * configuration BEFORE first enable. Display-only — never throws on a
 * missing field.
 */
import type { Operation } from 'effection';
import type {
  AbilityRegistry,
  AbilityConfigStore,
  AbilityFactory,
} from '@lloyal-labs/lloyal-agents';

export interface AbilityDescriptor {
  /** manifest.name (e.g. "web") — routing key + config-store key. */
  name: string;
  /** catalog metadata.title ?? manifest.hints?.shortName ?? protocol.name */
  title: string;
  /** manifest.hints?.description ?? protocol.useWhen */
  description: string;
  /** catalog metadata.iconUrl (apps.lloyal.ai asset) — else undefined → glyph. */
  iconUrl?: string;
  /** manifest.protocol.tools — the protocol's tool-name list. */
  tools: string[];
  /** catalog metadata.entitlements — capability keys
   *  (network|data-egress|local-files|credentials). */
  entitlements: string[];
  /** manifest.configSchema (JSON Schema). */
  configSchema?: unknown;
  /** Stored config REDACTED to key-presence — values never ride a wire. */
  config: Record<string, unknown>;
  /** Registry participation/enabled state. */
  enabled: boolean;
}

export function* buildAbilityDescriptors(
  registry: AbilityRegistry,
  configStore: AbilityConfigStore,
  installed: readonly AbilityFactory[],
): Operation<AbilityDescriptor[]> {
  const descriptors: AbilityDescriptor[] = [];
  const seen = new Set<string>();
  for (const ability of registry.enabled()) {
    const manifest = ability.manifest;
    const config = (yield* configStore.get(manifest.name)) ?? {};
    descriptors.push(describe(manifest, config, true));
    seen.add(manifest.name);
  }
  for (const factory of installed) {
    const manifest = factory.manifest;
    if (!manifest || seen.has(manifest.name)) continue;
    const config = (yield* configStore.get(manifest.name)) ?? {};
    descriptors.push(describe(manifest, config, false));
  }
  return descriptors;
}

type ManifestLike = {
  name: string;
  hints?: { shortName?: string; description?: string };
  protocol: { name: string; useWhen: string; tools: readonly string[] };
  configSchema?: unknown;
};

function describe(
  manifest: ManifestLike,
  config: Record<string, unknown>,
  enabled: boolean,
): AbilityDescriptor {
  return {
    name: manifest.name,
    title: manifest.hints?.shortName ?? manifest.protocol.name,
    description: manifest.hints?.description ?? manifest.protocol.useWhen,
    iconUrl: undefined,
    tools: [...manifest.protocol.tools],
    entitlements: [],
    configSchema: manifest.configSchema,
    // Key-presence only — the redaction is structural, not template discipline.
    config: Object.fromEntries(Object.keys(config).map((k) => [k, true])),
    enabled,
  };
}
