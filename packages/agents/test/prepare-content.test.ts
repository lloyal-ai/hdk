/**
 * prepareBatch — the media barrier before a prefill. Normalization is the
 * expensive step (seconds per image), and the normalizer already bounds
 * itself process-wide, so a batch must let its items overlap: results in
 * input order, execution not serialized.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import type { ContentIngress } from '@lloyal-labs/media';
import { prepareBatch } from '../src/prepare-content';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { rawIngress } from './helpers/raw-ingress';

const img = (n: number): Uint8Array[] =>
  Array.from({ length: n }, (_, i) => new Uint8Array([i, i + 1, i + 2, 0x89]));

describe('prepareBatch', () => {
  it('overlaps ingests instead of running them one after another', async () => {
    const store = new MemoryAttachmentStore();
    const raw = rawIngress(store);
    let inflight = 0;
    let peak = 0;
    const ingress: ContentIngress = {
      ingest: async (bytes, signal) => {
        inflight++;
        peak = Math.max(peak, inflight);
        try {
          await new Promise((r) => setTimeout(r, 20));
          return await raw.ingest(bytes, signal);
        } finally {
          inflight--;
        }
      },
    };
    const prepared = await run(function* () { return yield* prepareBatch(ingress, store, img(4)); });
    expect(prepared.bitmaps).toHaveLength(4);
    expect(peak).toBeGreaterThan(1);
  });
});
