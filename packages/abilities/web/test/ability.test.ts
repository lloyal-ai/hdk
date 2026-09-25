import { describe, it, expect, vi } from 'vitest';
import { run } from 'effection';
import { Trace, NullTraceWriter } from '@lloyal-labs/lloyal-agents';
import { AbilityConfigStoreCtx } from '@lloyal-labs/rig';
import { Services } from '@lloyal-labs/rig';
import type { ToolContext } from '@lloyal-labs/lloyal-agents';
import { createInMemoryConfigStore } from '@lloyal-labs/rig';
import { stubReranker } from './helpers/stub-reranker';
import { createWebAbility } from '../src/index';

describe('createWebAbility', () => {
  it('builds the web_research ability with full tool-map coverage', async () => {
    const ability = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('web', { tavilyKey: 'test-key' }); // Tavily path — no background pacer
      yield* AbilityConfigStoreCtx.set(store);
      yield* Services.set({ reranker: stubReranker });
      return yield* createWebAbility();
    });

    expect(ability.manifest.name).toBe('web');
    expect(ability.manifest.protocol.name).toBe('web_research');
    expect(ability.manifest.protocol.tools).toEqual(['web_search', 'fetch_page']);
    expect(ability.source.name).toBe('web');
    // Ability.tools (array) must cover exactly the protocol's tools.
    expect(ability.tools.map((t) => t.name).sort()).toEqual(['fetch_page', 'web_search']);
    // skill.eta must NOT carry the framework boundary marker (defineAbility would reject it).
    const agentSrc = typeof ability.skill === 'string' ? ability.skill : '';
    expect(agentSrc).not.toContain('Apply the **');
  });
});

describe('the reranker is the requirement', () => {
  it('with no reranker bound the factory is refused by name, before any tool exists — there is no fallback to build one without', async () => {
    await expect(run(function* () {
      yield* AbilityConfigStoreCtx.set(createInMemoryConfigStore());
      yield* Services.set({});
      return yield* createWebAbility();
    })).rejects.toThrow('`reranker` is not configured — add `model.reranker` to harness.yml');
  });
});

describe('fetch_page selects by query on the reranker', () => {
  const page = `<html><head><title>Cats and dogs</title></head><body><article>
    <h1>Cats and dogs</h1>
    <p>${'An introduction to the household animals of the world, their habits and their keepers, at some length so that the extractor takes the page for an article. '.repeat(4)}</p>
    <h2>Cats</h2>
    <p>${'Cats sleep for most of the day and hunt at dusk; a cat keeps its own hours and its own counsel, and answers to no schedule but hunger. '.repeat(4)}</p>
    <h2>Dogs</h2>
    <p>${'Dogs wake with the house and walk when walked; a dog keeps the hours of its people and forgives them everything. '.repeat(4)}</p>
  </article></body></html>`;

  it('returns the page\'s sections verbatim, scored against the query — never a truncation', async () => {
    vi.stubGlobal('fetch', async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }));
    try {
      const ability = await run(function* () {
        yield* AbilityConfigStoreCtx.set(createInMemoryConfigStore());
        yield* Trace.set(new NullTraceWriter());
        yield* Services.set({ reranker: stubReranker });
        return yield* createWebAbility();
      });
      const fetchPage = ability.tools.find((t) => t.name === 'fetch_page')!;
      const r = (await run(function* () {
        yield* Trace.set(new NullTraceWriter());
        return yield* fetchPage.execute({ url: 'https://example.com/pets', query: 'when do cats sleep' }, {} as ToolContext);
      })) as { title?: string; content?: string; chunks?: number; error?: string };
      expect(r.error).toBeUndefined();
      expect(r.chunks).toBeGreaterThan(0);
      expect(r.content).toContain('Cats sleep for most of the day');
      expect(r.content).not.toContain('[truncated]');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the result is what admission selected and nothing beside it — no excerpt rides past the budget', async () => {
    vi.stubGlobal('fetch', async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }));
    try {
      const ability = await run(function* () {
        yield* AbilityConfigStoreCtx.set(createInMemoryConfigStore());
        yield* Trace.set(new NullTraceWriter());
        yield* Services.set({ reranker: stubReranker });
        return yield* createWebAbility();
      });
      const fetchPage = ability.tools.find((t) => t.name === 'fetch_page')!;
      const r = (await run(function* () {
        yield* Trace.set(new NullTraceWriter());
        return yield* fetchPage.execute({ url: 'https://example.com/pets', query: 'when do cats sleep' }, {} as ToolContext);
      })) as Record<string, unknown>;
      expect(Object.keys(r).sort()).toEqual(['chunks', 'content', 'title', 'url']);
      // Every passage is a section of the page, whole, and there are exactly as many as `chunks` counts.
      const passages = (r.content as string).split('\n\n---\n\n');
      expect(passages.length).toBe(r.chunks);
      for (const passage of passages) expect(page.replace(/\s+/g, ' ')).toContain(passage.replace(/\s+/g, ' ').slice(0, 80));
      expect(fetchPage.description).not.toMatch(/excerpt/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a call with no query has nothing to select by, and says so', async () => {
    const ability = await run(function* () {
      yield* AbilityConfigStoreCtx.set(createInMemoryConfigStore());
      yield* Services.set({ reranker: stubReranker });
      return yield* createWebAbility();
    });
    const fetchPage = ability.tools.find((t) => t.name === 'fetch_page')!;
    const r = (await run(function* () {
      return yield* fetchPage.execute({ url: 'https://example.com/pets', query: '  ' }, {} as ToolContext);
    })) as { error?: string };
    expect(r.error).toBe('query must not be empty — say what to look for in this page');
    expect((fetchPage as { parameters: { required: string[] } }).parameters.required).toEqual(['url', 'query']);
  });
});

describe('fetch_page on a PDF', () => {
  it('names the way in — attach the file — instead of a dead end', async () => {
    const ability = await run(function* () {
      yield* AbilityConfigStoreCtx.set(createInMemoryConfigStore());
      yield* Trace.set(new NullTraceWriter());
      yield* Services.set({ reranker: stubReranker });
      return yield* createWebAbility();
    });
    const fetchPage = ability.tools.find((t) => t.name === 'fetch_page')!;
    const r = (await run(function* () {
      yield* Trace.set(new NullTraceWriter());
      return yield* fetchPage.execute({ url: 'https://example.com/paper.pdf' }, {} as ToolContext);
    })) as { error?: string };
    expect(r.error).toBe('This is a PDF, which fetch_page cannot read. Ask the user to attach the file to the conversation.');
  });
});
