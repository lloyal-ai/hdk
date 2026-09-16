/**
 * `coverage`: one probe per source on a shared spine, each source's report
 * joined under its protocol name in source order, a source that reported
 * nothing left out; the probe's turn cap is firm.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Channel } from 'effection';
import { createMockSdk } from '@lloyal-labs/sdk/dist/testing.js';
import type { ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { Ctx, Store, Events, Trace, Attachments, Ingress, NullTraceWriter, PoolDefaults } from '@lloyal-labs/lloyal-agents';
import type { AgentEvent, Ability } from '@lloyal-labs/lloyal-agents';
import { NullAttachmentStore } from '@lloyal-labs/media';
import { createAbilityRegistry } from '../src/registry';
import { createInMemoryConfigStore } from '../src/config-store';
import { coverage } from '../src/coverage';
import { fakeAbility } from './helpers/fake-ability';

const STOP = 999;
const PROMPT = { system: 'probe', user: 'Probe <%= it.ability.name %> for <%= it.query %>' };
const RECOVER = { system: 'r', user: 'report' };

describe('coverage', () => {
  it('probes each source once, joins what they reported under their protocol names, and leaves a silent source out', async () => {
    const { ctx, store } = createMockSdk({ nCtx: 16384 });
    // Every branch: one filler token, then stop; the report names the probe's own source by its turn order.
    const seen = new Map<number, number>();
    let last = 0;
    const reports = ['web covers the news', '', 'corpus covers the archive'];
    const byHandle = new Map<number, number>();
    ctx._branchSample = (h: number) => { last = h; const n = seen.get(h) ?? 0; seen.set(h, n + 1); if (!byHandle.has(h)) byHandle.set(h, byHandle.size); return n === 0 ? 7 : STOP; };
    ctx.parseChatOutput = (_raw: string, _f: unknown, opts?: ParseChatOutputOptions): ParseChatOutputResult => {
      if (opts?.isPartial) return { content: '', reasoningContent: '', toolCalls: [] };
      const body = reports[byHandle.get(last) ?? 0] ?? '';
      return { content: '', reasoningContent: '', toolCalls: [{ id: 'c1', name: 'report', arguments: JSON.stringify({ result: body }) }] };
    };
    const out = await run(function* () {
      yield* Ctx.set(ctx as never);
      yield* Store.set(store as never);
      const ch: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(ch as never);
      yield* Trace.set(new NullTraceWriter());
      yield* Attachments.set(new NullAttachmentStore());
      yield* Ingress.set({ ingest: () => { throw new Error('no ingress'); } } as never);
      yield* PoolDefaults.set({ pruneOnReturn: true });
      const registry = yield* createAbilityRegistry({ configStore: createInMemoryConfigStore() });
      const sources: Ability[] = [];
      for (const name of ['web', 'wiki', 'corpus']) sources.push(yield* registry.enable(fakeAbility({ name })));
      return yield* scoped(() => coverage({
        question: 'Q?', sources, prompt: PROMPT,
        budget: { maxTurns: 4, recovery: { prompt: RECOVER, minToolCalls: 1 } },
      }));
    });
    expect(out.coverage).toBe('### web_protocol\nweb covers the news\n\n### corpus_protocol\ncorpus covers the archive');
    expect(out.tokens).toBe(3); // one token per probe
    expect(out.timeMs).toBeGreaterThanOrEqual(0);
  });
});
