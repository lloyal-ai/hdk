/**
 * The resident context — one shared `llama_context` over the resident model;
 * every agent is a branch over it. One construction for every boot: the edge
 * boot makes one for its session, the served host one per admitted session
 * (lloyal.node's registry weak-caches the model by path, so the Nth shares
 * the weights and allocates only a fresh KV context).
 *
 * @category Runtime
 */
import { createContext as createNativeContext } from '@lloyal-labs/lloyal.node';
import type { SessionContext } from '@lloyal-labs/sdk';

/** The model block a boot resolved: the config's model keys with `path` concrete. */
export interface ResidentModel {
  path?: string;
  nCtx?: number;
  branches?: number;
  kvCache?: string;
  gpu?: string;
  imageMinTokens?: number;
  imageMaxTokens?: number;
}

/** How many branches a context seats when the manifest does not say. */
export const DEFAULT_N_SEQ_MAX = 32;
export const DEFAULT_N_CTX = 32768;

/**
 * Steer the native backend for BOTH the resident context AND the reranker via
 * `process.env.LLOYAL_GPU` (the reranker's loader exposes no passthrough). A
 * configured backend is an EXPLICIT request: fail loud on an unavailable
 * variant (`LLOYAL_NO_FALLBACK`, never overriding one the operator set) rather
 * than silently loading on CPU. With no gpu configured, an inherited
 * `LLOYAL_GPU` is CLEARED — config stays the sole source of truth.
 */
export function applyGpuEnv(model: { gpu?: string }): void {
  if (model.gpu) {
    process.env.LLOYAL_GPU = model.gpu;
    if (process.env.LLOYAL_NO_FALLBACK === undefined) process.env.LLOYAL_NO_FALLBACK = '1';
  } else if (process.env.LLOYAL_GPU !== undefined) {
    delete process.env.LLOYAL_GPU;
  }
}

/** The options one resident context is built from — pure, so a law can read them without a model. */
export function residentContextOptions(model: ResidentModel, mmprojPath?: string): {
  options: Record<string, unknown> & { modelPath: string; nCtx: number; nSeqMax: number };
  load?: { gpuVariant: string };
} {
  if (!model.path) throw new Error('the resident model has no path — resolve the models before building a context');
  return {
    options: {
      modelPath: model.path,
      nCtx: model.nCtx ?? DEFAULT_N_CTX,
      nSeqMax: model.branches ?? DEFAULT_N_SEQ_MAX,
      typeK: model.kvCache ?? 'q4_0',
      typeV: model.kvCache ?? 'q4_0',
      // Vision, when the boot resolved a projector: `mmprojPath` is a concrete file.
      ...(mmprojPath ? { mmprojPath } : {}),
      ...(model.imageMinTokens ? { imageMinTokens: model.imageMinTokens } : {}),
      ...(model.imageMaxTokens ? { imageMaxTokens: model.imageMaxTokens } : {}),
    },
    ...(model.gpu ? { load: { gpuVariant: model.gpu } } : {}),
  };
}

/** Build one resident context. */
export function createResidentContext(model: ResidentModel, mmprojPath?: string): Promise<SessionContext> {
  applyGpuEnv(model);
  const { options, load } = residentContextOptions(model, mmprojPath);
  return createNativeContext(options as Parameters<typeof createNativeContext>[0], load as Parameters<typeof createNativeContext>[1]);
}
