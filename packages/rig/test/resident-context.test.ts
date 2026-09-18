/**
 * One construction of the resident context for every boot: the manifest's
 * numbers when it has them, one default when it does not, the projector only
 * when resolved, and the backend steered through the environment for the
 * reranker's sake.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { residentContextOptions, applyGpuEnv, backendPackAdvice, DEFAULT_N_SEQ_MAX, DEFAULT_N_CTX } from '../src/resident-context';
import { DEFAULT_MAX_SESSIONS } from '../src/boot';

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

describe('the box says how many sessions it can hold', () => {
  it('four when it does not, and that number is a decision', () => {
    // Stated rather than read off the constant: this is a memory judgement, not an internal, and
    // changing it should be deliberate. Resident, not working — a session holds its context for as
    // long as its tab is open, so the cap bounds tabs left open, not queries in flight.
    expect(DEFAULT_MAX_SESSIONS).toBe(4);
  });

  it('and it is the only place the number lives: no boot option shadows the environment', () => {
    // Two homes for one value is two precedences, which is what makes "a validated cap"
    // unverifiable — an operator sets MAX_SESSIONS and an app's own option silently outranks it.
    const boot = readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'src', 'boot.ts'), 'utf8');
    expect(boot).not.toMatch(/opts\.(maxSessions|port|host)\b/);
    expect(/MAX_SESSIONS/.test(boot), 'the environment is still where it comes from').toBe(true);
  });
});

describe('the backend pack, as the boot speaks of it', () => {
  const linux = { platform: 'linux', arch: 'x64', backendDir: undefined, packDir: null, nvidia: true };
  it('a GPU the harness never named: the boot runs on CPU and says so', () => {
    expect(backendPackAdvice({}, linux)).toMatch(/unset — running on CPU/);
    expect(backendPackAdvice({ gpu: 'default' }, linux)).toMatch(/running on CPU/);
    expect(backendPackAdvice({}, { ...linux, nvidia: false })).toBeNull();
    expect(backendPackAdvice({}, { ...linux, platform: 'darwin' })).toBeNull();
  });
  it('a cuda boot on linux-x64 with no pack is told how the box gets one', () => {
    expect(backendPackAdvice({ gpu: 'cuda' }, linux)).toMatch(/lloyal-ai backends:install/);
    expect(backendPackAdvice({ gpu: 'cuda' }, linux)).toMatch(/LLOYAL_BACKEND_DIR/);
  });
  it('and nothing otherwise: another backend, another platform, a provisioned dir, a cached pack', () => {
    expect(backendPackAdvice({ gpu: 'vulkan' }, linux)).toBeNull();
    expect(backendPackAdvice({ gpu: 'cuda' }, { ...linux, platform: 'darwin', arch: 'arm64' })).toBeNull();
    expect(backendPackAdvice({ gpu: 'cuda' }, { ...linux, arch: 'arm64' })).toBeNull();
    expect(backendPackAdvice({ gpu: 'cuda' }, { ...linux, backendDir: '/opt/lloyal/pack' })).toBeNull();
    expect(backendPackAdvice({ gpu: 'cuda' }, { ...linux, packDir: '/home/x/.cache/lloyal/backends/3.2.0-linux-x64' })).toBeNull();
  });
});

