/**
 * Model catalog + verified, project-local resolution/fetch.
 *
 * The platform's curated default models, and the one walk that turns a
 * `harness.yml` model spec + a role into a concrete `.gguf` path — fetching
 * into the project's `models/<role>/<id>.gguf` slot on first use, **fail-closed
 * digest-verified** against the catalog's `sha256`. This lives in the platform
 * (a dep of the generated project), not in user-editable scaffold code, so the
 * integrity check can't be weakened downstream — the same trust bar as the
 * signed app channel, from the opposite direction.
 *
 * Node-only (node:fs / node:crypto / streaming fetch). Import from
 * `@lloyal-labs/rig/node`.
 *
 * @packageDocumentation
 * @category Rig
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** The model roles a harness provisions. `llm` always; `reranker` when an app
 *  requires it; `embedding` reserved for the first consumer. */
export type ModelRole = 'llm' | 'reranker' | 'embedding';

/**
 * A curated default model. `sha256` is the platform trust root — every catalog
 * fetch is verified against it, fail-closed. It never lives in `harness.yml`; a
 * dropped or `path:`-referenced weight is trusted by possession.
 */
export interface ModelCatalogEntry {
  /** Stable id; the on-disk slot is `models/<role>/<id>.gguf`. */
  id: string;
  role: ModelRole;
  /** Human label for progress + errors. */
  label: string;
  /** Download URLs in fallback order (upstream first, lloyal mirror second). */
  urls: string[];
  /** Fail-closed digest, lowercase hex. */
  sha256: string;
  /** Approx size, for a progress ETA when Content-Length is absent. */
  sizeBytes: number;
  /** Suggested `context` (nCtx) when the harness doesn't set one. */
  recommendedContext?: number;
}

const USER_AGENT = '@lloyal-labs/rig model-fetch';

/**
 * The platform's default catalog. Extend by adding an entry — no plumbing
 * change. `id`s are the friendly, dx-facing names (`reasoning-4b`), decoupled
 * from the upstream filename.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'reasoning-4b',
    role: 'llm',
    label: 'Reasoning 4B · Q4_K_M',
    urls: [
      'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
      'https://models.lloyal.ai/Qwen3.5-4B-Q4_K_M.gguf',
    ],
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    sizeBytes: 2_600_000_000,
    recommendedContext: 32768,
  },
  {
    id: 'qwen3-reranker-0.6b-q8',
    role: 'reranker',
    label: 'Qwen3 Reranker 0.6B · Q8_0',
    urls: [
      'https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf',
      'https://models.lloyal.ai/qwen3-reranker-0.6b-q8_0.gguf',
    ],
    sha256: '22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48',
    sizeBytes: 630_000_000,
  },
];

/** Look up a catalog entry by role + id. */
export function catalogEntry(role: ModelRole, id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((e) => e.role === role && e.id === id);
}

export type ModelProgress = (got: number, total: number, url: string) => void;

/** A `harness.yml` model spec (one role): either a catalog `id` or an explicit `path`. */
export interface ModelSpec {
  id?: string;
  path?: string;
}

export interface ResolveModelOpts {
  /** Project root (where `models/` lives). */
  projectRoot: string;
  role: ModelRole;
  /** The `harness.yml` entry for this role (may be omitted → scan the slot). */
  spec?: ModelSpec;
  onProgress?: ModelProgress;
}

/**
 * Resolve a `(role, spec)` to a concrete local `.gguf` path, fetching +
 * verifying if needed. The walk (dx.md §3.2):
 *
 *   explicit `path:`                  → use as-is (no copy; trusted by possession)
 *   `models/<role>/<id>.gguf` present → use it
 *   `id:`                             → catalog fetch + fail-closed digest → write the slot
 *   no id                             → exactly one `.gguf` in the role dir → adopt; >1 → fail clearly
 */
export async function resolveModel(opts: ResolveModelOpts): Promise<string> {
  const { projectRoot, role, spec, onProgress } = opts;
  const roleDir = path.join(projectRoot, 'models', role);

  // 1. explicit path — trusted by possession
  if (spec?.path) {
    const p = path.resolve(projectRoot, spec.path);
    if (!fs.existsSync(p)) {
      throw new Error(`Model path not found for role "${role}": ${p}`);
    }
    return p;
  }

  // 2/3. configured id → slot; fetch + verify if absent
  if (spec?.id) {
    const slot = path.join(roleDir, `${spec.id}.gguf`);
    if (fs.existsSync(slot)) return slot;
    const entry = catalogEntry(role, spec.id);
    if (!entry) {
      throw new Error(
        `Model "${spec.id}" (role "${role}") isn't at ${slot} and isn't in the catalog. ` +
          `Drop the .gguf there, or set a known catalog id.`,
      );
    }
    return fetchVerified(entry, slot, onProgress);
  }

  // 4. no id / no path → adopt the sole .gguf in the role dir, or fail clearly
  const present = fs.existsSync(roleDir)
    ? fs.readdirSync(roleDir).filter((f) => f.endsWith('.gguf'))
    : [];
  if (present.length === 1) return path.join(roleDir, present[0]);
  if (present.length === 0) {
    throw new Error(
      `No model configured for role "${role}" and none in models/${role}/. ` +
        `Set an id/path in harness.yml, or drop a .gguf there.`,
    );
  }
  throw new Error(
    `Ambiguous model for role "${role}": ${present.length} .gguf files in models/${role}/ ` +
      `(${present.join(', ')}). Set an explicit id/path in harness.yml.`,
  );
}

/** Stream a catalog entry into `dest`, verify sha256 fail-closed, atomic rename.
 *  Walks `entry.urls` in fallback order; a truncated or tampered download is
 *  deleted and errored, never renamed into place. */
async function fetchVerified(
  entry: ModelCatalogEntry,
  dest: string,
  onProgress?: ModelProgress,
): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  try { fs.unlinkSync(tmp); } catch { /* stale or first run */ }

  const errors: string[] = [];
  for (const url of entry.urls) {
    try {
      return await streamOne(entry, url, tmp, dest, onProgress);
    } catch (err) {
      errors.push(`  ${url}: ${(err as Error).message}`);
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
  throw new Error(`Failed to fetch ${entry.label} from any source:\n${errors.join('\n')}`);
}

async function streamOne(
  entry: ModelCatalogEntry,
  url: string,
  tmp: string,
  dest: string,
  onProgress?: ModelProgress,
): Promise<string> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') ?? entry.sizeBytes);

  const hash = createHash('sha256');
  let got = 0;
  let lastEmit = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb): void {
      hash.update(chunk);
      got += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastEmit >= 200) {
        lastEmit = now;
        onProgress(got, total, url);
      }
      cb(null, chunk);
    },
  });

  // Stream (never buffer 2.6 GB) with correct backpressure via pipeline.
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    meter,
    fs.createWriteStream(tmp),
  );

  const digest = hash.digest('hex');
  if (digest !== entry.sha256) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error(
      `Digest mismatch for ${entry.label}: expected ${entry.sha256}, got ${digest} — refusing to load.`,
    );
  }
  fs.renameSync(tmp, dest);
  onProgress?.(got, total, url);
  return dest;
}
