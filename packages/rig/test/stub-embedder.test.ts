/**
 * The stub embedder a scenario runs against mirrors the contract: it says
 * what it reads and frames, and refuses what it cannot read before any work.
 */
import { describe, expect, it } from 'vitest';
import { run } from 'effection';
import { stubEmbedder } from '../src/testing';
import { EMBEDDING_TASKS } from '../src/retrieval';
import type { Attachment } from '@lloyal-labs/media';

describe('stubEmbedder', () => {
  it('reads text, frames every task, and answers vectors of its one width', async () => {
    expect(stubEmbedder).toMatchObject({ dimension: 2, dimensions: [2], modalities: ['text'], tasks: EMBEDDING_TASKS });
    const vectors = await run(() => stubEmbedder.embed(['a', { parts: ['b'], task: 'clustering', role: 'query' }]));
    expect(vectors.map((v) => [...v])).toEqual([[1, 0], [1, 0]]);
  });

  it('refuses the whole call when a part is media, as an embedder without a projector does', async () => {
    const image = { digest: 'sha256:' + '0'.repeat(64), mediaType: 'application/vnd.oci.image.manifest.v1+json', size: 1 } as unknown as Attachment;
    await expect(run(() => stubEmbedder.embed(['fine', { parts: [image] }]))).rejects.toThrow(/input 1 .*cannot read/);
    await expect(run(() => stubEmbedder.measure([{ parts: [image] }]))).rejects.toThrow(/input 0 .*cannot read/);
  });
});
