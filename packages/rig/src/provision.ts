/**
 * Provision the HDK Services an enabled ability set declares.
 *
 * An Ability declares the auxiliary Services it needs (`reranker`, `embedding`)
 * via its manifest's `services` (carried statically on the `AbilityFactory`, mirrored
 * from `ability.json`) — it declares the *service*, not a model. The harness boot
 * passes the same factory list it will enable; this reads the aggregate
 * requirement and — for each service some ability needs — resolves + loads the model
 * that backs it and publishes the bound instance on the framework context abilities
 * read at construction, BEFORE any factory runs.
 *
 * Today only `reranker` is wired (`RerankerCtx`). The reranker is
 * one-cross-encoder-per-harness, so a single shared instance is loaded IFF some
 * enabled ability requires it — a conditional populate of the existing global
 * context, not a per-ability instance. `embedding` is reserved (no consumer yet).
 *
 * Node-only (`resolveModel` + `createReranker` touch `node:fs` / the native
 * runtime). Import from `@lloyal-labs/rig/node`.
 *
 * @packageDocumentation
 * @category Rig
 */
import { call } from 'effection';
import type { Operation } from 'effection';
import { RerankerCtx } from '@lloyal-labs/lloyal-agents';
import type { AbilityFactory, Service } from '@lloyal-labs/lloyal-agents';
import { MODEL_CATALOG, resolveModel } from './models';
import type { ModelProgress, ModelSpec } from './models';
import { createReranker } from './reranker';
import type { RerankerLoadOpts } from './reranker';

/** Options for {@link provisionAbilityModels}. */
export interface ProvisionAbilityModelsOpts {
  /**
   * The ability factories the harness will enable. Their static `services` is read
   * to decide which auxiliary Services to load — the factories are NOT run here.
   */
  abilities: readonly AbilityFactory[];
  /** Project root (where `models/<role>/` lives). */
  projectRoot: string;
  /**
   * Optional model spec for the reranker service, from `harness.yml`
   * `model.reranker`. Absent → the platform catalog's reranker default.
   */
  reranker?: ModelSpec;
  /**
   * Optional context-sizing overrides for the reranker load (`nSeqMax`/`nCtx`/
   * `nBatch`), threaded into `createReranker`. Absent → its defaults (nSeqMax
   * 10 · nCtx 4096). Lets a harness tune the shared reranker without
   * hand-loading it — e.g. a larger `nCtx` for longer rerank inputs.
   */
  rerankerLoad?: RerankerLoadOpts;
  onProgress?: ModelProgress;
}

/** The auxiliary models an ability set's declared Services need, on disk. Absent
 *  when nothing declares the Service — never a default a boot assumed. */
export interface AbilityModels {
  /** The reranker some enabled ability requires; absent when none does. */
  reranker?: string;
}

/**
 * What an ability set REQUIRES on disk, resolved (fetched + verified on first
 * use) but not loaded. The requirement is read off the abilities' declared
 * `services` — never assumed from the product the harness happens to be — and
 * an explicit spec only names WHICH model backs a service some ability asked
 * for.
 *
 * Separate from the load because a boot's two lifetimes differ: a served host
 * fetches once, before it listens, and loads per session, while an edge boot
 * does both at once. Both ask this question, and get the same answer.
 */
export function* resolveAbilityModels(opts: ProvisionAbilityModelsOpts): Operation<AbilityModels> {
  const services = new Set<Service>(opts.abilities.flatMap((a) => a.manifest?.services ?? []));

  // Fail fast on unsupported services BEFORE resolving anything, so an
  // unimplemented requirement can't leave a half-loaded reranker behind.
  if (services.has('embedding')) {
    throw new Error(
      "provisionAbilityModels: an enabled ability requires an 'embedding' model, but " +
        'embedding provisioning is not implemented yet (EmbeddingCtx/Embedder ' +
        "are reserved). Remove the ability, or its 'embedding' requirement, until it lands.",
    );
  }

  if (!services.has('reranker')) return {};

  // Pin from harness.yml only when it actually NAMES a model (id or path); a
  // `reranker:` block with only tuning (e.g. `context:`) must NOT suppress the
  // catalog fallback and leave resolveModel with an id-less, path-less spec.
  const pinned = opts.reranker?.id || opts.reranker?.path ? opts.reranker : undefined;
  const fallback = MODEL_CATALOG.find((e) => e.role === 'reranker');
  const spec = pinned ?? (fallback ? { id: fallback.id } : undefined);
  const reranker = yield* call(() =>
    resolveModel({
      projectRoot: opts.projectRoot,
      role: 'reranker',
      spec,
      onProgress: opts.onProgress,
    }),
  );
  return { reranker };
}

/**
 * Read the aggregate `services` of `abilities`, provision each required Service, and
 * publish the bound instance on its framework context — so `registry.enable`
 * injects it. Call once at boot, BEFORE `createAbilityRegistry`/`enable`, in the
 * scope the harness runs in: the reranker resource + `RerankerCtx` value both
 * attach to that scope (the same "set the context in the caller's scope"
 * pattern as `createAbilityRegistry`), living for its lifetime.
 *
 * No-op when no enabled ability requires an auxiliary Service (e.g. a wikipedia-only
 * harness) — nothing is fetched or loaded.
 */
export function* provisionAbilityModels(opts: ProvisionAbilityModelsOpts): Operation<void> {
  const models = yield* resolveAbilityModels(opts);
  if (models.reranker) {
    const reranker = yield* createReranker(models.reranker, opts.rerankerLoad);
    yield* RerankerCtx.set(reranker);
  }
}
