/**
 * One construction of the resident context for every boot: the manifest's
 * numbers when it has them, one default when it does not, the projector only
 * when resolved, and the backend steered through the environment for the
 * reranker's sake.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { residentContextOptions, applyGpuEnv, DEFAULT_N_SEQ_MAX, DEFAULT_N_CTX } from '../src/resident-context';

const saved = { gpu: process.env.LLOYAL_GPU, fallback: process.env.LLOYAL_NO_FALLBACK };
afterEach(() => {
  if (saved.gpu === undefined) delete process.env.LLOYAL_GPU; else process.env.LLOYAL_GPU = saved.gpu;
  if (saved.fallback === undefined) delete process.env.LLOYAL_NO_FALLBACK; else process.env.LLOYAL_NO_FALLBACK = saved.fallback;
});

describe('residentContextOptions', () => {
  it('maps the model block onto the native options, defaulting what the manifest left out', () => {
    const { options, load } = residentContextOptions({ path: '/m.gguf' });
    expect(options).toEqual({ modelPath: '/m.gguf', nCtx: DEFAULT_N_CTX, nSeqMax: DEFAULT_N_SEQ_MAX, typeK: 'q4_0', typeV: 'q4_0' });
    expect(load).toBeUndefined();
  });

  it('carries the manifest\'s branches, context, cache type, image budgets, the projector and the backend', () => {
    const { options, load } = residentContextOptions(
      { path: '/m.gguf', nCtx: 8192, branches: 5, kvCache: 'q8_0', gpu: 'cuda', imageMinTokens: 256, imageMaxTokens: 1024 }, '/mm.gguf');
    expect(options).toEqual({ modelPath: '/m.gguf', nCtx: 8192, nSeqMax: 5, typeK: 'q8_0', typeV: 'q8_0', mmprojPath: '/mm.gguf', imageMinTokens: 256, imageMaxTokens: 1024 });
    expect(load).toEqual({ gpuVariant: 'cuda' });
  });

  it('refuses a model without a path', () => {
    expect(() => residentContextOptions({})).toThrow(/no path/);
  });
});

describe('applyGpuEnv', () => {
  it('a configured backend is an explicit request: set, and no silent fallback unless the operator said so', () => {
    delete process.env.LLOYAL_NO_FALLBACK;
    applyGpuEnv({ gpu: 'vulkan' });
    expect(process.env.LLOYAL_GPU).toBe('vulkan');
    expect(process.env.LLOYAL_NO_FALLBACK).toBe('1');
    process.env.LLOYAL_NO_FALLBACK = '0';
    applyGpuEnv({ gpu: 'cuda' });
    expect(process.env.LLOYAL_NO_FALLBACK).toBe('0');
  });

  it('with no backend configured, an inherited LLOYAL_GPU is cleared — config is the one source', () => {
    process.env.LLOYAL_GPU = 'cuda';
    applyGpuEnv({});
    expect(process.env.LLOYAL_GPU).toBeUndefined();
  });
});
