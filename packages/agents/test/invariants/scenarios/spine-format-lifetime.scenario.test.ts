/**
 * Scenario: a shared spine's chat format belongs to the agents that fork from it, for as long as its body runs.
 *
 * `withSpine({ systemPrompt, tools })` prefills a `[system + tools]` header and tells the agents of its body,
 * through `SpineFmt`, that the header is already in their KV — so each leaves its own tools out of its suffix.
 * That is only true of agents forked from that spine. An agent started after the body, in the same scope, has
 * no such header behind it, and formatted as if it did it never learns its own tools exist.
 *
 * What this locks:
 *   - `withSpine` sets `SpineFmt` with `SpineFmt.with`, so the caller's value is back when the body ends —
 *     returned, thrown or nested.
 *   - The body's own non-shared children still inherit it: they fork from the spine.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, spawn, suspend } from 'effection';
import type { Channel, Operation } from 'effection';
import { createMockSdk } from '../../../../sdk/src/testing.js';
import { withSpine } from '../../../src/spine';
import { agent } from '../../../src/use-agent';
import { agentPool } from '../../../src/create-agent-pool';
import { parallel } from '../../../src/orchestrators';
import { Ctx, Store, Events, Trace, Attachments, Ingress, SpineFmt } from '../../../src/context';
import type { AgentEvent } from '../../../src/types';
import { MemoryAttachmentStore } from '../../helpers/memory-store';
import { rawIngress } from '../../helpers/raw-ingress';
import { CapturingTraceWriter } from '../../helpers/capturing-trace';
import { MockTool } from '../../helpers/mock-tool';

/** Every chat format asked for, in order: its system text and whether it carried tool schemas. */
interface Formatted { system: string; tools: boolean }

/** Run `body` with the pool's contexts over a mock whose formats name their own system text as their grammar,
 *  so two spines' formats can be told apart. */
async function withContexts<T>(body: () => Operation<T>): Promise<{ value: T; formats: Formatted[] }> {
  const { ctx, store } = createMockSdk({ nCtx: 16384, cellsUsed: 0 });
  const formats: Formatted[] = [];
  const format = ctx.formatChatSync.bind(ctx);
  ctx.formatChatSync = (msgs, opts) => {
    const system = (JSON.parse(msgs) as { role: string; content: string }[]).find((m) => m.role === 'system')?.content ?? '';
    formats.push({ system, tools: typeof opts === 'object' && opts !== null && !!opts.tools });
    return { ...format(msgs, opts), grammar: `grammar of ${system}` };
  };
  const value = await run(function* () {
    yield* Ctx.set(ctx as never);
    yield* Store.set(store);
    const events: Channel<AgentEvent, void> = createChannel();
    yield* Events.set(events as never);
    yield* Trace.set(new CapturingTraceWriter());
    const content = new MemoryAttachmentStore();
    yield* Attachments.set(content);
    yield* Ingress.set(rawIngress(content));
    return yield* body();
  });
  return { value, formats };
}

const SHARED = { systemPrompt: 'the shared role', tools: [new MockTool('shared_tool')] };

describe('scenario: a shared spine\'s format lives as long as its body', () => {
  it('is gone once the body returns: an agent started afterwards formats its own tools', async () => {
    const { formats } = await withContexts(function* () {
      yield* withSpine(SHARED, function* () {});
      yield* agent({ systemPrompt: 'an unrelated agent', content: 'task', tools: [new MockTool('own_tool')] });
    });
    const own = formats.find((f) => f.system === 'an unrelated agent');
    expect(own, 'the unrelated agent was never formatted').toBeDefined();
    expect(own!.tools, 'formatted as a child of a spine it does not descend from, it never sees its tools').toBe(true);
  });

  it('is gone when the body throws', async () => {
    const { value } = await withContexts(function* () {
      try {
        yield* withSpine(SHARED, function* () { throw new Error('boom'); });
      } catch { /* the body's failure is the caller's to handle; the format must not outlive it */ }
      return yield* SpineFmt.get();
    });
    expect(value ?? null).toBeNull();
  });

  it('is the outer spine\'s again once a nested shared spine returns', async () => {
    const { value } = await withContexts(function* () {
      return yield* withSpine({ ...SHARED, systemPrompt: 'outer' }, function* () {
        yield* withSpine({ ...SHARED, systemPrompt: 'inner' }, function* () {});
        return (yield* SpineFmt.get())?.grammar ?? null;
      });
    });
    expect(value).toBe('grammar of outer');
  });

  it('still reaches the non-shared children of its body, which fork from it', async () => {
    const { formats } = await withContexts(function* () {
      yield* withSpine(SHARED, function* (spine) {
        // `parent` is what makes them children: they fork from the spine's KV, which already holds the header.
        yield* agentPool({ parent: spine, orchestrate: parallel([{ systemPrompt: 'a child', content: 'task' }]), tools: [new MockTool('shared_tool')] });
      });
    });
    const child = formats.find((f) => f.system === 'a child');
    expect(child, 'the child was never formatted').toBeDefined();
    expect(child!.tools, 'its header is the spine\'s, already in its KV').toBe(false);
  });

  it('never reaches the enclosing scope when the body is halted', async () => {
    const { value } = await withContexts(function* () {
      const task = yield* spawn(function* () {
        yield* withSpine(SHARED, function* () { yield* suspend(); });
      });
      yield* task.halt();
      return yield* SpineFmt.get();
    });
    expect(value ?? null).toBeNull();
  });
});
