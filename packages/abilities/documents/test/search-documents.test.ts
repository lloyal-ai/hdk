import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { Trace, NullTraceWriter } from '@lloyal-labs/lloyal-agents';
import type { ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Attachment } from '@lloyal-labs/media';
import { documentIndexer, documentId, NO_DOCUMENTS } from '../src/documents-index';
import { SearchDocumentsTool } from '../src/tools/search-documents';
import type { DocumentHit } from '../src/tools/search-documents';
import { makeFixture, makeSecond, scoringReranker } from './helpers/fixture';

type Envelope = { hits: DocumentHit[]; totalScored: number; error?: string };

function setup() {
  const fx = makeFixture();
  const reranker = scoringReranker();
  const indexFor = documentIndexer(fx.store, (t) => reranker.tokenize(t));
  const tool = new SearchDocumentsTool(indexFor, reranker);
  const search = (args: { query: string; document?: string }, attachments: readonly Attachment[], agentId = 1) =>
    run(function* () {
      yield* Trace.set(new NullTraceWriter());
      return (yield* tool.execute(args, { agentId, attachments } as ToolContext)) as Envelope;
    });
  return { ...fx, tool, search };
}

describe('search_documents', () => {
  it('hits carry the document, its id, its pages and a cite URL', async () => {
    const { doc, image, search } = setup();
    const r = await search({ query: 'baseline cells' }, [image, doc]);
    expect(r.error).toBeUndefined();
    expect(r.totalScored).toBeGreaterThan(0);
    const results = r.hits.find((h) => h.heading === 'Results');
    expect(results).toMatchObject({
      document: 'Fixture Paper', id: documentId(doc), file: documentId(doc),
      pageStart: 2, pageEnd: 2, cite: `attachment://${documentId(doc)}/page/2`,
    });
    expect(results!.startLine).toBe(7);
  });

  it('scopes to one document by title or id, and names the attached ones for an unknown scope', async () => {
    const { store, doc, search } = setup();
    const second = makeSecond(store);
    const byTitle = await search({ query: 'delta', document: 'Second Report' }, [doc, second]);
    expect(byTitle.hits.length).toBeGreaterThan(0);
    expect(byTitle.hits.every((h) => h.id === documentId(second))).toBe(true);
    const byId = await search({ query: 'delta', document: documentId(doc) }, [doc, second]);
    expect(byId.hits.every((h) => h.id === documentId(doc))).toBe(true);
    const unknown = await search({ query: 'delta', document: 'Third' }, [doc, second]);
    expect(unknown.error).toMatch(/Unknown document: Third\. Attached: Fixture Paper \([0-9a-f]{12}\), Second Report/);
  });

  it('answers honestly when nothing is attached, and when only an image is', async () => {
    const { image, search } = setup();
    expect((await search({ query: 'anything' }, [])).error).toBe(NO_DOCUMENTS);
    expect((await search({ query: 'anything' }, [image])).error).toBe(NO_DOCUMENTS);
    expect((await search({ query: '  ' }, [])).error).toMatch(/must not be empty/);
  });

  it('returns the best passages even when the judge says no to all of them — the ranker is relative, there is no floor', async () => {
    const { doc, search } = setup();
    const r = await search({ query: 'zxqv plorth wibble' }, [doc]);
    expect(r.error).toBeUndefined();
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.length).toBeLessThanOrEqual(5);
    expect(r.hits.every((h) => h.score < 0)).toBe(true);
    // The hits are the ranking's prefix: addresses intact, in score order.
    expect(r.hits.every((h) => h.startLine >= 1 && h.cite.startsWith('attachment://'))).toBe(true);
  });

  it("scores in explore mode whatever the run's stance — the attached document is the on-topic universe, so the original question never vetoes a passage", async () => {
    const { doc, tool } = setup();
    const scorer = {
      scoreEntailmentBatch: async () => { throw new Error('the entailment scorer must not be consulted for a document search'); },
    };
    const r = await run(function* () {
      yield* Trace.set(new NullTraceWriter());
      return (yield* tool.execute({ query: 'baseline cells' }, { attachments: [doc], explore: false, scorer } as unknown as ToolContext)) as Envelope;
    });
    expect(r.error).toBeUndefined();
    expect(r.hits.length).toBeGreaterThan(0);
  });
});

