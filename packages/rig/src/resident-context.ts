/**
 * The resident context — one shared `llama_context` over the resident model;
 * every agent is a branch over it. One construction for every boot: the edge
 * boot makes one for its session, the served host one per admitted session
 * (lloyal.node's registry weak-caches the model by path, so the Nth shares
 * the weights and allocates only a fresh KV context).
 *
 * @category Runtime
 */
import { spawnSync } from 'node:child_process';
import { createContext as createNativeContext, resolveBackendPackDirSync } from '@lloyal-labs/lloyal.node';
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

/**
 * What a `gpu: cuda` boot on linux-x64 is told when no backend pack is on the box — the one thing rig says
 * about the pack, because acquiring it is provisioning (`lloyal backends:install`, or a deploy that sets
 * `LLOYAL_BACKEND_DIR`), never a boot's. Null when there is nothing to say: another backend, another platform,
 * or a pack already there. Pure, so the boot writes it and a test reads the table.
 */
export function backendPackAdvice(
  model: { gpu?: string },
  world: { platform?: string; arch?: string; backendDir?: string; packDir?: string | null; nvidia?: boolean } = {},
): string | null {
  const platform = world.platform ?? process.platform;
  const arch = world.arch ?? process.arch;
  if (platform !== 'linux' || arch !== 'x64') return null;
  if (model.gpu === undefined || model.gpu === 'default') {
    // The box has a GPU and the harness never said so: the boot runs on CPU, and says it.
    if (!(world.nvidia ?? nvidiaGpuPresent())) return null;
    return (
      '[rig] an NVIDIA GPU is present but model.llm.gpu is unset — running on CPU. Once per box: ' +
      '`npx lloyal-ai backends:install` (it sets gpu: cuda in harness.yml).'
    );
  }
  if (model.gpu !== 'cuda') return null;
  if (world.backendDir ?? process.env.LLOYAL_BACKEND_DIR) return null;
  if ((world.packDir === undefined ? resolveBackendPackDirSync() : world.packDir) !== null) return null;
  return (
    '[rig] gpu: cuda with no backend pack on this box — the npm package serves sm_86/89 natively and runs ' +
    'JIT-degraded or fails elsewhere (Blackwell, Hopper). Once per box: `npx lloyal-ai backends:install`, or ' +
    'provision the pack and set LLOYAL_BACKEND_DIR.'
  );
}

/**
 * The one backend step a boot takes before its context: the env the addon reads, then whatever the box
 * should be told. Both boots call this and nothing else about the backend, so a line said here is said on
 * every surface, and a test of it is a test of them.
 */
export function prepareBackend(model: { gpu?: string }, say: (line: string) => void = (l) => process.stderr.write(`${l}\n`), world?: Parameters<typeof backendPackAdvice>[1]): void {
  applyGpuEnv(model);
  const advice = backendPackAdvice(model, world);
  if (advice) say(advice);
}

/** Whether `nvidia-smi` reports a device — one cheap call, only ever on linux-x64. */
function nvidiaGpuPresent(): boolean {
  const r = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', timeout: 5_000 });
  return r.status === 0 && (r.stdout ?? '').trim() !== '';
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
