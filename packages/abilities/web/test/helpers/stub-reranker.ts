/**
 * The reranker these tests bind: typed against the contract, never cast past it, so a change to `Reranker`
 * is a compile error here. Every chunk admitted, in the order given — the same stand-in rig's own testing
 * barrel provides (this tree resolves modules the classic way and cannot see that barrel's export).
 */
import type { Reranker } from '@lloyal-labs/rig';

export const stubReranker: Reranker = {
  score: async function* (_query, chunks) {
    yield {
      results: chunks.map((c) => ({ file: c.resource, heading: c.heading, section: c.section, snippet: c.text.slice(0, 200), score: 0, startLine: c.startLine, endLine: c.endLine })),
      filled: chunks.length,
      total: chunks.length,
    };
  },
  scoreBatch: async (_q, texts) => texts.map(() => 0),
  tokenizeChunks: async () => {},
  tokenize: async () => [],
  dispose: () => {},
};
