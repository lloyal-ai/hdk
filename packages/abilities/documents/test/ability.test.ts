import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from 'effection';
import { RerankerCtx, Attachments } from '@lloyal-labs/lloyal-agents';
import type { Reranker } from '@lloyal-labs/rig';
import { createDocumentsAbility } from '../src/index';
import { makeFixture, wordTokenize } from './helpers/fixture';

const mockReranker = { tokenize: wordTokenize } as unknown as Reranker;
const pkg = join(__dirname, '..');

describe('createDocumentsAbility', () => {
  it('builds document_research with the three tools and the documents source', async () => {
    const { store } = makeFixture();
    const ability = await run(function* () {
      yield* RerankerCtx.set(mockReranker);
      yield* Attachments.set(store);
      return yield* createDocumentsAbility();
    });
    expect(ability.manifest.protocol.name).toBe('document_research');
    expect(ability.manifest.services).toEqual(['reranker']);
    expect(ability.manifest.configSchema).toBeUndefined();
    expect(ability.source.name).toBe('documents');
    expect(ability.tools.map((t) => t.name).sort()).toEqual(['read_document', 'search_documents', 'view_page']);
  });

  it('ships a skill in the corpus register: no boundary marker, no toc variable', () => {
    const skill = readFileSync(join(pkg, 'skill.eta'), 'utf8');
    expect(skill).not.toContain('Apply the **');
    expect(skill).not.toContain('it.toc');
    expect(skill).toContain('view_page is expensive');
  });

  it('throws a clear error when no reranker is set', async () => {
    await expect(run(function* () { return yield* createDocumentsAbility(); })).rejects.toThrow(/requires a reranker/);
  });

  it('constructs with the default store and no attachments, and the toc is empty', async () => {
    const source = await run(function* () {
      yield* RerankerCtx.set(mockReranker);
      return (yield* createDocumentsAbility()).source;
    });
    expect(source.promptData()).toEqual({ toc: '' });
    expect(source.promptData([])).toEqual({ toc: '' });
  });

  it('never reaches the native addon: no lloyal.node peer and no node-only sibling entry in src', () => {
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { peerDependencies: Record<string, string> };
    expect(Object.keys(manifest.peerDependencies)).not.toContain('@lloyal-labs/lloyal.node');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(pkg, 'src'));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/lloyal\.node|@lloyal-labs\/(rig|media)\/node/);
    }
  });
});
