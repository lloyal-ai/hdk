/**
 * The sources a run can research with: enabled, not switched off, with something
 * to read for this run's assets; and the spine's reference block, which is each
 * participating source's advert for those assets, rendered once.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { createAbilityRegistry } from '../src/registry';
import { createInMemoryConfigStore } from '../src/config-store';
import { participating, abilityToc } from '../src/participating';
import { renderSpine } from '../src/spine-render';
import { fakeAbility } from './helpers/fake-ability';

const web = fakeAbility({ name: 'web' });                                              // advertises nothing: always in
const corpus = fakeAbility({ name: 'corpus', toc: () => 'a.md\nb.md' });               // a catalog
const documents = fakeAbility({ name: 'documents', toc: (a) => a.map(() => 'paper').join('\n') }); // keyed on the assets

describe('participating', () => {
  it('leaves out a switched-off source and one whose catalog is empty for this run; an advert-less source is always in', async () => {
    const names = await run(function* () {
      const registry = yield* createAbilityRegistry({ configStore: createInMemoryConfigStore() });
      for (const f of [web, corpus, documents]) yield* registry.enable(f);
      return {
        bare: (yield* participating()).map((a) => a.manifest.name),
        withDoc: (yield* participating([], [{ digest: 'sha256:x' } as never])).map((a) => a.manifest.name),
        noCorpus: (yield* participating(['corpus'], [{ digest: 'sha256:x' } as never])).map((a) => a.manifest.name),
      };
    });
    expect(names.bare).toEqual(['web', 'corpus']);
    expect(names.withDoc).toEqual(['web', 'corpus', 'documents']);
    expect(names.noCorpus).toEqual(['web', 'documents']);
  });

  it('abilityToc is the advert or null', async () => {
    const [w, c] = await run(function* () {
      const registry = yield* createAbilityRegistry({ configStore: createInMemoryConfigStore() });
      return [yield* registry.enable(web), yield* registry.enable(corpus)];
    });
    expect(abilityToc(w)).toBeNull();
    expect(abilityToc(c)).toBe('a.md\nb.md');
  });
});

describe('renderSpine({ reference })', () => {
  it('appends one block per source that advertises something for the run\'s assets; without `reference` no ability prose reaches the spine', async () => {
    const [w, c, d] = await run(function* () {
      const registry = yield* createAbilityRegistry({ configStore: createInMemoryConfigStore() });
      return [yield* registry.enable(web), yield* registry.enable(corpus), yield* registry.enable(documents)];
    });
    const plain = renderSpine({ abilities: [w, c, d] });
    expect(plain).not.toContain('available files');
    const withRef = renderSpine({ abilities: [w, c, d], reference: [{ digest: 'sha256:x' } as never] });
    expect(withRef.startsWith(plain)).toBe(true);
    expect(withRef).toContain('# corpus_protocol — available files\na.md\nb.md');
    expect(withRef).toContain('# documents_protocol — available files\npaper');
    expect(withRef).not.toContain('# web_protocol — available files');
    const empty = renderSpine({ abilities: [w, c, d], reference: [] });
    expect(empty).toContain('corpus_protocol — available files');
    expect(empty).not.toContain('documents_protocol — available files');
  });
});
