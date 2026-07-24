/**
 * Provision the auxiliary model roles an enabled app set declares.
 *
 * An AgentApp declares the non-`llm` models it needs via its manifest's
 * `requires` (carried statically on the `AppFactory`, mirrored from `app.json`).
 * The harness boot passes the same
 * factory list it will enable; this reads the aggregate requirement and — for
 * each role some app needs — resolves + loads the model and publishes it on the
 * framework context apps read at construction, BEFORE any factory runs.
 *
 * Today only `reranker` is wired (`RerankerCtx`). The reranker is
 * one-cross-encoder-per-harness, so a single shared instance is loaded IFF some
 * enabled app requires it — a conditional populate of the existing global
 * context, not a per-app service. `embedding` is reserved (no consumer yet).
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
import type { AppFactory, AppModelRole } from '@lloyal-labs/lloyal-agents';
import { MODEL_CATALOG, resolveModel } from './models';
import type { ModelProgress, ModelSpec } from './models';
import { createReranker } from './reranker';

/** Options for {@link provisionAppModels}. */
export interface ProvisionAppModelsOpts {
  /**
   * The app factories the harness will enable. Their static `requires` is read
   * to decide which auxiliary models to load — the factories are NOT run here.
   */
  apps: readonly AppFactory[];
  /** Project root (where `models/<role>/` lives). */
  projectRoot: string;
  /**
   * Optional model spec for the reranker role, from `harness.yml`
   * `model.reranker`. Absent → the platform catalog's reranker default.
   */
  reranker?: ModelSpec;
  onProgress?: ModelProgress;
}

/**
 * Read the aggregate `requires` of `apps`, provision each required role, and
 * publish the bound service on its framework context — so `registry.enable`
 * injects it. Call once at boot, BEFORE `createAppRegistry`/`enable`, in the
 * scope the harness runs in: the reranker resource + `RerankerCtx` value both
 * attach to that scope (the same "set the context in the caller's scope"
 * pattern as `createAppRegistry`), living for its lifetime.
 *
 * No-op when no enabled app requires an auxiliary role (e.g. a wikipedia-only
 * harness) — nothing is fetched or loaded.
 */
export function* provisionAppModels(opts: ProvisionAppModelsOpts): Operation<void> {
  const roles = new Set<AppModelRole>(opts.apps.flatMap((a) => a.manifest?.requires ?? []));

  // Fail fast on unsupported roles BEFORE provisioning anything, so an
  // unimplemented requirement can't leave a half-loaded reranker behind.
  if (roles.has('embedding')) {
    throw new Error(
      "provisionAppModels: an enabled app requires an 'embedding' model, but " +
        'embedding provisioning is not implemented yet (EmbeddingCtx/Embedder ' +
        "are reserved). Remove the app, or its 'embedding' requirement, until it lands.",
    );
  }

  if (roles.has('reranker')) {
    // Pin from harness.yml only when it actually NAMES a model (id or path); a
    // `reranker:` block with only tuning (e.g. `context:`) must NOT suppress the
    // catalog fallback and leave resolveModel with an id-less, path-less spec.
    const pinned = opts.reranker?.id || opts.reranker?.path ? opts.reranker : undefined;
    const fallback = MODEL_CATALOG.find((e) => e.role === 'reranker');
    const spec = pinned ?? (fallback ? { id: fallback.id } : undefined);
    const modelPath = yield* call(() =>
      resolveModel({
        projectRoot: opts.projectRoot,
        role: 'reranker',
        spec,
        onProgress: opts.onProgress,
      }),
    );
    const reranker = yield* createReranker(modelPath);
    yield* RerankerCtx.set(reranker);
  }
}
