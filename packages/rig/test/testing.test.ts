/**
 * The behavioural rig's platform half: what an application's scenarios stand on.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { admitChunks } from '@lloyal-labs/lloyal-agents';
import type { Chunk } from '@lloyal-labs/lloyal-agents';
import { stubReranker } from '../src/testing';

const chunk = (i: number): Chunk => ({ resource: `r${i}.md`, heading: `H${i}`, section: `S${i}`, text: `text ${i} `.repeat(30), tokens: [], startLine: 1, endLine: 3 });

describe('stubReranker', () => {
  it('admits every chunk it is given, scored 0, in the order given — a retrieval under the rig is never silently empty', async () => {
    const chunks = [chunk(1), chunk(2), chunk(3)];
    const batches: unknown[] = [];
    for await (const b of stubReranker.score('q', chunks)) batches.push(b);
    expect(batches).toHaveLength(1);
    const admitted = await run(() => admitChunks(stubReranker, chunks, 'q', undefined, { tool: 'search', select: { mode: 'budget', topK: 10, tokenBudget: 10_000 } }));
    expect(admitted.scored.map((c) => c.file)).toEqual(['r1.md', 'r2.md', 'r3.md']);
    expect(admitted.scored.every((c) => c.score === 0)).toBe(true);
  });
});

// ── The rig over a harness of its own ────────────────────────────────────────
//
// A harness small enough to live here, booted the way every application is
// (`initializeHarness`): it says `ready`, then answers each `ask` with one
// agent whose scripted turn the scenario chose. Enough to exercise the rig's
// choreography, its parse keying, and its refusals.
import { each, spawn } from 'effection';
import type { Operation, Signal } from 'effection';
import type { SessionContext } from '@lloyal-labs/sdk';
import type { EventBus } from '@lloyal-labs/binding';
import { useAgent, Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';
import { defineConfig, modelSettings } from '../src/config';
import { initializeHarness } from '../src/initialize-harness';
import { runHarness } from '../src/testing';

const table = defineConfig({ ...modelSettings, 'sources.outputDir': { yml: 'sources.outputDir', path: true, default: 'out' } });
type Command = { type: 'ask'; text: string } | { type: 'quit' };
type Event = { type: 'ready' } | { type: 'answer'; text: string } | { type: string };

/** One agent per ask, ending on free text; `work` is what the ask runs. */
const tiny = (work: (text: string) => Operation<string>) =>
  function* (ctx: SessionContext, events: EventBus<Event>, commands: Signal<Command, void>): Operation<void> {
    const { wire } = yield* initializeHarness(ctx, events, { abilities: [], config: table });
    yield* wire.send({ type: 'ready' });
    for (const c of yield* each(commands)) {
      if (c.type === 'quit') return;
      yield* wire.send({ type: 'answer', text: yield* work(c.text) });
      yield* each.next();
    }
  };
const oneAgent = function* (text: string): Operation<string> {
  const a = yield* useAgent({ systemPrompt: 's', content: text, acceptFreeText: true });
  return a.result ?? '';
};
const spec = { config: { table, yml: (dir: string) => ({ sources: { outputDir: dir } }) } };
const askThenAnswer = [{ on: (e: Event) => e.type === 'ready', send: { type: 'ask', text: 'Q' } as Command }, { on: (e: Event) => e.type === 'answer' }];

describe('runHarness over a harness of its own', () => {
  it('walks the script: sends, waits, answers, quits — and a text turn parses as content', async () => {
    const run = await runHarness<typeof table, Command, Event>({
      ...spec, harness: tiny(oneAgent),
      utterances: [{ text: 'forty-two', kind: 'text' }],
      script: askThenAnswer,
    });
    expect(run.events.filter((e) => e.type === 'ready' || e.type === 'answer').map((e) => e.type)).toEqual(['ready', 'answer']);
    expect((run.events.find((e) => e.type === 'answer') as { text: string }).text).toBe('forty-two');
    expect(run.halted).toBe(false);
  });

  it('refuses a harness that returned with the script still waiting', async () => {
    const early = function* (ctx: SessionContext, events: EventBus<Event>): Operation<void> {
      const { wire } = yield* initializeHarness(ctx, events, { abilities: [], config: table });
      yield* wire.send({ type: 'ready' });
    };
    await expect(runHarness<typeof table, Command, Event>({ ...spec, harness: early, script: askThenAnswer }))
      .rejects.toThrow(/returned with the script at step [01]\/2/);
  });

  it("two tool turns with the same text and different arguments are each their own: the branch sampled last is asked first", async () => {
    // The reviewer's reproduction: two scripted searches, alpha and beta, empty text both. Keyed on the first
    // branch whose text matches, both parsed as alpha; keyed on the branch sampled last, each is its own.
    const asked: string[] = [];
    class Search extends Tool<{ q: string }> {
      readonly name = 'search';
      readonly description = 'records what it was asked';
      readonly parameters: JsonSchema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
      *execute(args: { q: string }): Operation<unknown> { asked.push(args.q); return { hits: [] }; }
    }
    const twoAgents = function* (text: string): Operation<string> {
      const tools = [new Search()];
      const a = yield* spawn(() => useAgent({ systemPrompt: 's', content: text, tools, acceptFreeText: true }));
      const b = yield* spawn(() => useAgent({ systemPrompt: 's', content: text, tools, acceptFreeText: true }));
      const [ra, rb] = [yield* a, yield* b];
      return `${ra.result}${rb.result}`;
    };
    const run = await runHarness<typeof table, Command, Event>({
      ...spec, harness: tiny(twoAgents),
      utterances: [
        { text: '', kind: 'tool', tool: { name: 'search', args: { q: 'alpha' } }, then: { text: 'A', kind: 'text' } },
        { text: '', kind: 'tool', tool: { name: 'search', args: { q: 'beta' } }, then: { text: 'B', kind: 'text' } },
      ],
      script: askThenAnswer,
    });
    expect(asked.sort()).toEqual(['alpha', 'beta']);
    expect((run.events.find((e) => e.type === 'answer') as { text: string }).text).toBe('AB');
  });
});
