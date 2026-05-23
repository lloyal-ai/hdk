import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from 'effection';
import { AppConfigStoreCtx, RerankerCtx } from '@lloyal-labs/lloyal-agents';
import type { Reranker } from '@lloyal-labs/rig';
import { createInMemoryConfigStore } from '@lloyal-labs/rig';
import { createCorpusApp } from '../src/index';

// The factory only calls reranker.tokenizeChunks at construction; search
// scoring (which needs a real cross-encoder) isn't exercised here.
const mockReranker = { tokenizeChunks() {} } as unknown as Reranker;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'corpus-app-'));
  writeFileSync(join(dir, 'doc.md'), '# Title\n\nSome corpus content about transformer architecture.\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createCorpusApp', () => {
  it('builds the corpus_research app with full tool-map coverage', async () => {
    const app = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('corpus', { corpusPath: dir });
      yield* AppConfigStoreCtx.set(store);
      yield* RerankerCtx.set(mockReranker);
      return yield* createCorpusApp();
    });

    expect(app.manifest.contract.name).toBe('corpus_research');
    expect(app.source.name).toBe('corpus');
    expect(app.tools.map((t) => t.name).sort()).toEqual(['grep', 'read_file', 'search']);
  });

  it('throws a clear error when no reranker is set', async () => {
    await expect(
      run(function* () {
        const store = createInMemoryConfigStore();
        yield* store.set('corpus', { corpusPath: dir });
        yield* AppConfigStoreCtx.set(store);
        return yield* createCorpusApp();
      }),
    ).rejects.toThrow(/requires a reranker/);
  });

  it('throws when corpusPath config is missing', async () => {
    await expect(
      run(function* () {
        yield* AppConfigStoreCtx.set(createInMemoryConfigStore());
        yield* RerankerCtx.set(mockReranker);
        return yield* createCorpusApp();
      }),
    ).rejects.toThrow(/corpusPath/);
  });
});
