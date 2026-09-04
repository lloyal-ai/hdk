/**
 * A halted run still closes its trace scopes.
 *
 * `scope:open` / `scope:close` are what give the trace its TREE. Effection
 * documents three ways out of a scope — return, error, and HALT — and
 * `traceScope` returned a `{traceId, close}` pair, so closing was a thing each
 * caller had to remember on each of those paths. Two of three callers closed
 * on return (and one on error) but none on halt, so a cancelled run left an
 * unclosed scope: a malformed tree at exactly the moment it is most worth
 * reading.
 *
 * The shape is the one the plan already retired for `useTraceWriter` — a
 * caller-must-close pair where `resource()` exists.
 */
import { describe, it, expect } from 'vitest';
import { createScope, suspend } from 'effection';
import { MockSessionContext } from '../../sdk/src/testing.js';
import { BranchStore } from '../../sdk/src/BranchStore';
import { Ctx, Store, Trace, Events } from '../src/context';
import { useAgent } from '../src/use-agent';
import { CapturingTraceWriter } from './helpers/capturing-trace';
import { createChannel } from 'effection';
import type { AgentEvent } from '../src/types';

describe('a halted scope closes its trace scope', () => {
  it('emits scope:close for every scope:open when the run is cancelled', async () => {
    const ctx = new MockSessionContext({ nCtx: 16384, cellsUsed: 0 });
    const store = new BranchStore(ctx);
    const trace = new CapturingTraceWriter();

    const [scope, destroy] = createScope();
    let reached!: () => void;
    const running = new Promise<void>((r) => { reached = r; });

    scope.run(function*() {
      yield* Ctx.set(ctx as never);
      yield* Store.set(store as never);
      yield* Trace.set(trace);
      yield* Events.set(createChannel<AgentEvent, void>());
      yield* useAgent({ systemPrompt: 'you are a test', task: 'do nothing', tools: [] });
      reached();
      // Held open so the scope is torn down from OUTSIDE — a halt, not a
      // return. This is the path no caller covered.
      yield* suspend();
    }).catch(() => { /* halted */ });

    await running;
    await destroy();

    const opened = trace.ofType('scope:open').map(e => e.traceId);
    const closed = trace.ofType('scope:close').map(e => e.parentTraceId);

    expect(opened.length, 'the run must have opened a scope').toBeGreaterThan(0);
    expect(closed.sort(), 'a halted run left an unclosed scope in the trace')
      .toEqual(opened.sort());
  });
});
