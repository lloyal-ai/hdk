/**
 * The framework's walk over the providers: the services a configuration names, each one's
 * artifact resolved into its slot, and each artifact bound through its provider into reach. Naming a
 * block is the request — `model.reranker` present means a reranker is provisioned, absent means
 * none is, whatever the abilities declare; what an ability declares is checked where it enables.
 * Resolving and binding are separate because a boot's two lifetimes differ: a served host
 * resolves once, before it listens, and binds per session; an edge boot does both at once.
 *
 * Node-only (`resolveModel` and every row's `bind` touch `node:fs` / the native runtime).
 * Import from `@lloyal-labs/rig/node`.
 *
 * @packageDocumentation
 * @category Rig
 */
import { call } from 'effection';
import type { Operation } from 'effection';
import type { ContextOptions } from '@lloyal-labs/sdk';
import type { ModelFamily } from './config';
import { resolveModel } from './models';
import type { ModelProgress, ModelSpec } from './models';
import { SERVICES, Services } from './services';
import type { Service, ServiceMap } from './services';
import { providers } from './providers';
import type { ModelBlock, ProviderRow } from './providers';

/**
 * The services a configuration requests: every one whose block is present, in the table's order.
 * An empty block is a request; an absent one is a decision.
 *
 * @category Rig
 */
export function configuredServices(model: ModelFamily): Service[] {
  return SERVICES.filter((name) => model[name] !== undefined);
}

/** Where the artifacts come from. */
export interface ProvisionOpts {
  /** Project root (where `models/<service>/` lives). */
  projectRoot: string;
  /** The layered model family: each service's block selects its model and carries its tuning. */
  model: ModelFamily;
  onProgress?: (service: Service, got: number, total: number) => void;
}

/** The artifact each resolved service binds from: the model file in its slot. */
export type ServiceArtifacts = Partial<Record<Service, string>>;

/** The block's selection: `path`, else `id`, else what the row derives from the llm. A block that names neither
 *  and derives nothing asked for a service and chose no model — a request nothing can satisfy, refused by the
 *  keys that would. A selection the row still cannot bind is refused here too, on the first step that can know. */
export function specOf(name: Service, model: ModelFamily): ModelSpec {
  const block: ModelSpec | undefined = model[name];
  const row = providers[name];
  const spec = block?.path ? { path: block.path } : block?.id ? { id: block.id } : row.derive?.({ llm: model.llm ?? {} });
  if (!spec) {
    throw new Error(
      `\`model.${name}\` names no model${row.derive ? ' and none follows from the llm' : ''} — ` +
        `set \`model.${name}.id\` (a catalog id) or \`model.${name}.path\` in harness.yml`,
    );
  }
  const refused = refusalOf(name, model);
  if (refused) throw new Error(refused);
  return spec;
}

/** What the row says stops its block from being bound, before anything runs — a refusal no file can answer. */
export function refusalOf<K extends Service>(name: K, model: ModelFamily): string | undefined {
  const row: ProviderRow<K> = providers[name];
  return row.refuse?.((model[name] ?? {}) as ModelBlock<K>);
}

/**
 * What a boot must have on disk for the services it configured: each artifact resolved — fetched
 * and verified on first use — into its slot, and nothing loaded.
 *
 * @category Rig
 */
export function* resolveServices(configured: readonly Service[], opts: ProvisionOpts): Operation<ServiceArtifacts> {
  const artifacts: ServiceArtifacts = {};
  for (const name of configured) {
    const onProgress: ModelProgress | undefined = opts.onProgress ? (got, total) => opts.onProgress!(name, got, total) : undefined;
    artifacts[name] = yield* call(() =>
      resolveModel({ projectRoot: opts.projectRoot, role: name, spec: specOf(name, opts.model), ...(onProgress ? { onProgress } : {}) }),
    );
  }
  return artifacts;
}

/**
 * Bind each artifact through its row, in the caller's scope, and put the instances in reach:
 * `service(name)` answers them here and in every ability scope the registry seeds from here.
 * The bound instances live as long as this scope.
 *
 * @category Rig
 */
export function* bindServices(artifacts: ServiceArtifacts, model: ModelFamily): Operation<void> {
  const bound: Partial<ServiceMap> = {};
  for (const name of SERVICES) {
    const artifact = artifacts[name];
    if (artifact !== undefined) yield* bindRow(bound, name, artifact, model);
  }
  yield* Services.set(bound);
}

/** One provider's instance into the bag: what `bind` yields, or — for a trunk provider, whose artifact is already
 *  on the resident context — the marker that says it is there. */
function* bindRow<K extends Service>(bound: Partial<ServiceMap>, name: K, artifact: string, model: ModelFamily): Operation<void> {
  const row: ProviderRow<K> = providers[name];
  const block = (model[name] ?? {}) as ModelBlock<K>;
  bound[name] = row.bind ? yield* row.bind(artifact, block) : ({ artifact } as ServiceMap[K]);
}

/**
 * What the trunk providers contribute to the resident context, from the artifacts the install acquired — folded
 * before the context is built, once per boot, so every session's trunk has the same sight.
 *
 * @category Rig
 */
export function trunkOptions(artifacts: ServiceArtifacts, model: ModelFamily): Partial<ContextOptions> {
  let options: Partial<ContextOptions> = {};
  for (const name of SERVICES) {
    const artifact = artifacts[name];
    if (artifact !== undefined) options = { ...options, ...trunkRow(name, artifact, model) };
  }
  return options;
}

/** What one provider contributes to the resident context — nothing, for one that binds an instance of its own. */
function trunkRow<K extends Service>(name: K, artifact: string, model: ModelFamily): Partial<ContextOptions> {
  const row: ProviderRow<K> = providers[name];
  return row.trunk ? row.trunk(artifact, (model[name] ?? {}) as ModelBlock<K>) : {};
}
