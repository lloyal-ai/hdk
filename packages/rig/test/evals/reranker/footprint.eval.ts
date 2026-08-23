/**
 * RESOURCE: what the reranker's KV cache costs per quantisation type.
 *
 *   npx tsx packages/rig/test/evals/reranker/footprint.eval.ts [nCtx]
 *
 * Computed from the model's own hparams, and cross-checked against RSS. The
 * computed figure is authoritative: RSS under-counts lazily-allocated Metal
 * pages at larger nCtx (measured +675 MiB where the arithmetic says +1288 at
 * nCtx 16384), and on a discrete-GPU host it would miss the allocation entirely.
 *
 * Recorded 2026-08-18, Qwen3-Reranker-0.6B, nCtx 4096 — computed vs RSS agreed
 * to within 0.5 MB at this size:
 *
 *   q4_0  126 MiB      q5_0  154 MiB      q8_0  238 MiB      f16  448 MiB
 *
 * Pair with isolation.eval.ts: that one gives the noise each type costs you,
 * this one gives the memory. f16 was chosen because q8_0's floor (0.122) is
 * larger than the tightest margin measured (0.061).
 */

import { rerankerModelPath, contextWithKv, type KvType } from './fixtures';
import { openSync, readSync, closeSync } from 'node:fs';

/** Bytes per KV value. q-types are (block bytes / 32 values). */
const BYTES_PER_VALUE: Record<KvType, number> = {
  q4_0: 18 / 32,   // 16 data + 2 scale
  q5_0: 22 / 32,   // 16 + 4 high bits + 2 scale
  q8_0: 34 / 32,   // 32 data + 2 scale
  f16: 2,
};

/** Minimal GGUF metadata read — only the handful of keys the arithmetic needs. */
function ggufHparams(path: string): Record<string, number> {
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(96 * 1024 * 1024);
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  if (buf.toString('ascii', 0, 4) !== 'GGUF') throw new Error('not a GGUF file');

  let o = 4;
  const u32 = (): number => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const u64 = (): number => { const v = Number(buf.readBigUInt64LE(o)); o += 8; return v; };
  const str = (): string => { const n = u64(); const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const val = (t: number): unknown => {
    switch (t) {
      case 0: case 7: { const v = buf.readUInt8(o); o += 1; return v; }
      case 1: { const v = buf.readInt8(o); o += 1; return v; }
      case 2: { const v = buf.readUInt16LE(o); o += 2; return v; }
      case 3: { const v = buf.readInt16LE(o); o += 2; return v; }
      case 4: return u32();
      case 5: { const v = buf.readInt32LE(o); o += 4; return v; }
      case 6: { const v = buf.readFloatLE(o); o += 4; return v; }
      case 8: return str();
      case 9: { const et = u32(); const n = u64(); for (let i = 0; i < n; i++) val(et); return null; }
      case 10: return u64();
      case 11: { const v = Number(buf.readBigInt64LE(o)); o += 8; return v; }
      case 12: { const v = buf.readDoubleLE(o); o += 8; return v; }
      default: throw new Error(`unknown GGUF value type ${t}`);
    }
  };

  u32();                       // version
  u64();                       // tensor count
  const nkv = u64();
  const want = new Set(['block_count', 'attention.head_count_kv', 'attention.key_length']);
  const out: Record<string, number> = {};
  for (let i = 0; i < nkv; i++) {
    const k = str();
    const v = val(u32());
    const short = k.split('.').slice(1).join('.');
    if (want.has(short) && typeof v === 'number') out[short] = v;
    if (Object.keys(out).length === want.size) break;
  }
  return out;
}

async function main(): Promise<void> {
  const nCtx = Number(process.argv[2] ?? 4096);
  const modelPath = await rerankerModelPath();
  const h = ggufHparams(modelPath);
  const layers = h['block_count'];
  const kvHeads = h['attention.head_count_kv'];
  const headDim = h['attention.key_length'];

  // K and V, per head, per layer, per token.
  const valuesPerToken = 2 * kvHeads * headDim * layers;
  console.log(
    `${modelPath.split('/').pop()}\n` +
      `  ${layers} layers · ${kvHeads} KV heads · head_dim ${headDim} ` +
      `= ${valuesPerToken.toLocaleString()} KV values/token\n` +
      `  nCtx ${nCtx}\n`,
  );

  const MB = 1024 * 1024;
  const base = valuesPerToken * nCtx * BYTES_PER_VALUE.q4_0 / MB;
  for (const kv of ['q4_0', 'q5_0', 'q8_0', 'f16'] as KvType[]) {
    const mib = valuesPerToken * nCtx * BYTES_PER_VALUE[kv] / MB;
    const delta = mib - base;
    console.log(
      `  ${kv.padEnd(5)} ${mib.toFixed(0).padStart(5)} MiB` +
        (delta > 0 ? `   +${delta.toFixed(0)} vs q4_0` : '   (baseline)'),
    );
  }

  // Spot-check the arithmetic against a real allocation at the default size.
  const before = process.memoryUsage().rss;
  const ctx = await contextWithKv(modelPath, 'f16', nCtx);
  await ctx.tokenize('warm', true);
  const after = process.memoryUsage().rss;
  console.log(
    `\n  RSS delta for an f16 context (weights included, so > KV alone): ` +
      `${((after - before) / MB).toFixed(0)} MB`,
  );
  ctx.dispose();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
