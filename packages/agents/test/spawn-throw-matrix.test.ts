/**
 * Only the refusals the code means are refusals.
 *
 * A spawn can fail to exist for three honest reasons the pool names: no room
 * (`pressure_init`), no sequence (`no_sequence`), or a heal whose lineage
 * cannot be rebuilt (its content gone, its parent gone or moved, its replay
 * not fitting). Every other throw on the way to a seat is a programming error
 * or a contract mismatch, and it must reach the run as the error it is: the
 * pool fails with it, the ledger entry settles as `spawn_error`, and the
 * siblings stood down by the same throw settle as `withdrawn`. No entry is
 * ever left open, reading `{ agentId: null, failed: null }` as if nothing
 * happened.
 *
 * From the matrix, over every shape: a throw in pricing, in the suffix
 * prefill (plain, and with rc 1), in replay (rc 1 stands the heal down; a
 * plain throw is the run's); a fork throw with a sequence free; a heal
 * pricing throw that is not a lost lineage.
 */
import { describe, it, expect } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { AgentPolicy } from '../src/AgentPolicy';
import type { Orchestrator, SpawnSpec } from '../src/orchestrators';
import { parallel, chain, fanout, dag } from '../src/orchestrators';
import type { Tool } from '../src/Tool';
import { runPool, STOP } from './invariants/harness';
import type { InstrumentedMockSessionContext, PoolRun } from './invariants/harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX, mediaFailures } from './helpers/media';
import { MemoryAttachmentStore } from './helpers/memory-store';
import { Tool as BaseTool, TOOL_ATTACHMENTS_KEY } from '../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../src/types';

/** One completed text call, then an image: the lineage a heal replays is the first call, and the second is poisoned. */
class TextThenImage extends BaseTool<{ query: string }> {
  readonly name = 'rasterize';
  readonly description = 'text once, then an image';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  calls = 0;
  *execute(): Operation<unknown> {
    this.calls++;
    if (this.calls === 1) return { results: ['a short finding'] };
    return { page: 'p1', [TOOL_ATTACHMENTS_KEY]: [PNG_BYTES] };
  }
}
import { I42_noLeakedBranches, formatResult } from './invariants/predicates';

const spec = (i: number): SpawnSpec => ({ content: `Task ${i}`, systemPrompt: 'You are an agent.', seed: i });

/** The four shapes, each over two tasks; Task 1 is spawned second in every shape but `parallel`. */
const shapes: Record<string, () => Orchestrator> = {
  parallel: () => parallel([spec(0), spec(1)]),
  chain: () => chain([0, 1], (i) => ({ task: spec(i), userContent: `Task ${i}` })),
  fanout: () => fanout({ task: spec(0), userContent: 'Task 0' }, [spec(1)]),
  dag: () => dag([{ id: 'a', task: spec(0) }, { id: 'b', task: spec(1), dependsOn: ['a'] }]),
};

const prose: AgentPolicy = {
  onProduced: (_a, parsed) => ({ type: 'free_text_return', content: parsed.content ?? '' }),
  shouldExit: () => false,
};
const callsTools: AgentPolicy = {
  onProduced: (_a, parsed) => parsed.toolCalls.length > 0
    ? { type: 'tool_call', tc: parsed.toolCalls[0] }
    : { type: 'idle', reason: 'free_text_stop' },
  onRecovery: () => ({ type: 'skip' }),
  shouldExit: () => false,
};

const plainScripts = [{ tokens: [1, STOP], content: 'r0' }, { tokens: [1, STOP], content: 'r1' }];

/** An entry the ledger never settled reads as nothing having happened. */
const openEntries = (run: PoolRun) => run.result.outcomes.filter(o => o.agentId === null && o.failed === null);

/** `MATRIX_DIAG=<file>` appends what each run did, before the assertions read it. */
const diag = (label: string, run: PoolRun): void => {
  if (!process.env.MATRIX_DIAG) return;
  const counts: Record<string, number> = {};
  for (const e of run.traceEvents) counts[e.type] = (counts[e.type] ?? 0) + 1;
  appendFileSync(process.env.MATRIX_DIAG!, `DIAG ${label}: error=${run.error ? `${(run.error as Error).name}: ${(run.error as Error).message} @ ${String((run.error as Error).stack).split('\n').slice(1, 6).map(s => s.trim()).join(' | ')}` : 'none'} failure=${run.result.failure?.message ?? 'none'} outcomes=${JSON.stringify(run.result.outcomes?.map(o => ({ agentId: o.agentId, failed: o.failed, result: o.result })))} trace=${JSON.stringify(counts)}\n`);
};

/** Every fork made on this run, in order (the harness numbers scripts by it). */
function forkHandles(ctx: InstrumentedMockSessionContext): number[] {
  const handles: number[] = [];
  const inner = ctx._branchFork.bind(ctx);
  ctx._branchFork = (parent: number): number => { const h = inner(parent); handles.push(h); return h; };
  return handles;
}

describe.each(Object.keys(shapes))('spawn throw matrix: %s', (shape) => {
  it('a throw in pricing fails the run with that error and settles the entry as spawn_error', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0, scripts: plainScripts, policy: prose, orchestrate: shapes[shape](),
      instrument: (ctx) => {
        const inner = ctx.formatChatSync.bind(ctx);
        ctx.formatChatSync = (msgs, opts) => {
          if (msgs.includes('Task 1')) throw new Error('a throw in pricing');
          return inner(msgs, opts);
        };
      },
    });
    diag(`${shape} pricing`, run);
    expect(run.result.failure?.message).toBe('a throw in pricing');
    expect(openEntries(run), 'an entry was left open').toEqual([]);
    expect(run.result.outcomes.some(o => o.failed === 'spawn_error'), 'the throw did not settle as spawn_error').toBe(true);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });

  it('a fork throw with a sequence free is an error, not a no_sequence refusal', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0, scripts: plainScripts, policy: prose, orchestrate: shapes[shape](),
      instrument: (ctx) => {
        let forks = 0;
        const inner = ctx._branchFork.bind(ctx);
        ctx._branchFork = (parent: number): number => {
          if (++forks === 2) throw new Error('a throw at the fork');
          return inner(parent);
        };
      },
    });
    diag(`${shape} fork`, run);
    expect(run.result.failure?.message).toBe('a throw at the fork');
    expect(run.traceEvents.some(e => e.type === 'pool:spawnRefused'), 'a programming error was recorded as a refusal').toBe(false);
    expect(openEntries(run), 'an entry was left open').toEqual([]);
    expect(run.result.outcomes.some(o => o.failed === 'spawn_error')).toBe(true);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });

  it.each([{ rc: undefined }, { rc: 1 }])('a throw in the suffix prefill ($rc) fails the run and settles every entry in the batch', async ({ rc }) => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0, scripts: plainScripts, policy: prose, orchestrate: shapes[shape](),
      captureError: true,
      instrument: (ctx) => {
        const inner = ctx._storePrefill.bind(ctx);
        let armed = true;
        ctx._storePrefill = async (handles, tokenArrays) => {
          // The spawn batch: a handle other than the root's. Once.
          if (armed && handles.some(h => h !== 1)) {
            armed = false;
            throw Object.assign(new Error('the suffix would not prefill'), rc !== undefined ? { rc, partial: false } : {});
          }
          return inner(handles, tokenArrays);
        };
      },
    });
    diag(`${shape} suffix ${rc}`, run);
    expect(run.result.failure?.message).toBe('the suffix would not prefill');
    expect(openEntries(run), 'an entry was left open').toEqual([]);
    expect(run.result.outcomes.filter(o => o.failed === 'spawn_error').length).toBeGreaterThan(0);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });

  it.each([
    // The lineage did not fit: the heal stands down, the run goes on.
    { rc: 1, failure: null },
    // Anything else on the replay is the run's error, as it is anywhere else on the way to a seat.
    { rc: undefined, failure: 'the replay would not prefill' },
  ])('a throw in replay (rc $rc) leaves the original\'s failure standing, never a refusal reading', async ({ rc, failure }) => {
    // Fork 0 asks for an image and is poisoned; the pool forges a replacement whose replay prefill throws.
    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX, cellsUsed: 0,
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'rasterize', arguments: '{}' } }, { tokens: [1, STOP], content: 'r1' }],
      tools: new Map<string, Tool>([['rasterize', new TextThenImage() as unknown as Tool]]),
      policy: callsTools, orchestrate: shapes[shape](),
      captureError: true,
      instrument: (ctx) => {
        const forks = forkHandles(ctx);
        // The replacement is the first fork made after the poison, whatever the shape has forked by then.
        let poisonedAt = -1;
        ctx.mockMultimodalError = () => {
          if (poisonedAt < 0) poisonedAt = forks.length;
          return { message: 'compute failed', rc: -3, partial: false };
        };
        const inner = ctx._storePrefill.bind(ctx);
        let onReplacement = 0;
        ctx._storePrefill = async (handles, tokenArrays) => {
          // The replacement's first prefill is its suffix, its second the replay.
          const replacement = poisonedAt < 0 ? undefined : forks[poisonedAt];
          if (replacement !== undefined && handles.includes(replacement) && ++onReplacement === 2) {
            throw Object.assign(new Error('the replay would not prefill'), rc !== undefined ? { rc, partial: false } : {});
          }
          return inner(handles, tokenArrays);
        };
      },
    });
    diag(`${shape} replay ${rc}`, run);
    expect(mediaFailures(run.channelEvents), 'the image prefill must have been poisoned').toHaveLength(1);
    const original = (mediaFailures(run.channelEvents)[0] as { agentId: number }).agentId;
    expect(run.result.failure?.message ?? null).toBe(failure);
    const entry = run.result.outcomes.find(o => o.agentId === original || o.failed === 'pressure_init');
    expect(entry?.agentId, 'the entry moved to a replacement that never landed').toBe(original);
    expect(entry?.failed).toBe('media_prefill_failed');
    expect(run.traceEvents.some(e => e.type === 'pool:agentHeal'), 'a replay that failed was announced as a heal').toBe(false);
    expect(openEntries(run)).toEqual([]);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });

  it('a heal pricing throw that is not a lost lineage fails the run instead of standing down in silence', async () => {
    const run = await runPool({
      nCtx: MEDIA_TEST_NCTX, cellsUsed: 0,
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'rasterize', arguments: '{}' } }, { tokens: [1, STOP], content: 'r1' }],
      tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
      policy: callsTools, orchestrate: shapes[shape](),
      captureError: true,
      instrument: (ctx) => {
        ctx.mockMultimodalError = () => ({ message: 'compute failed', rc: -3, partial: false });
        // The heal re-prices the original's task: the second format of Task 0 is the heal's.
        let formats = 0;
        const inner = ctx.formatChatSync.bind(ctx);
        ctx.formatChatSync = (msgs, opts) => {
          if (msgs.includes('Task 0') && ++formats === 2) throw new Error('a throw in the heal\'s pricing');
          return inner(msgs, opts);
        };
      },
    });
    diag(`${shape} heal-pricing`, run);
    expect(mediaFailures(run.channelEvents)).toHaveLength(1);
    expect(run.result.failure?.message).toBe('a throw in the heal\'s pricing');
    expect(openEntries(run)).toEqual([]);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });

  /** The lineage's content store, armed by the poison: what it does at the heal's pricing is the case. The agent's
   *  first image lands and its second is poisoned, so the lineage the heal prices carries a media result and the
   *  store is read again, armed, at that pricing. */
  const storeAtHealPricing = (atPricing: (digest: string) => ReturnType<MemoryAttachmentStore['getManifest']>) => {
    const store = new MemoryAttachmentStore();
    const getManifest = store.getManifest.bind(store);
    let armed = false;
    store.getManifest = (digest) => (armed ? atPricing(digest) : getManifest(digest));
    return { store, arm: () => { armed = true; } };
  };
  const healAfterPoison = (shape: string, atPricing: (digest: string) => ReturnType<MemoryAttachmentStore['getManifest']>) => {
    const { store, arm } = storeAtHealPricing(atPricing);
    return runPool({
      nCtx: MEDIA_TEST_NCTX, cellsUsed: 0, attachments: store,
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'rasterize', arguments: '{}' } }, { tokens: [1, STOP], content: 'r1' }],
      tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
      policy: callsTools, orchestrate: shapes[shape](),
      captureError: true,
      instrument: (ctx) => {
        let projections = 0;
        ctx.mockMultimodalError = () => {
          if (++projections !== 2) return null;
          arm();
          return { message: 'compute failed', rc: -3, partial: false };
        };
      },
    });
  };

  it('a heal whose store throws at pricing fails the run: a programming error is not a lost lineage', async () => {
    const run = await healAfterPoison(shape, () => { throw new TypeError('a type error from the store at pricing'); });
    diag(`${shape} heal-store-throw`, run);
    expect(mediaFailures(run.channelEvents)).toHaveLength(1);
    expect(run.result.failure?.message).toBe('a type error from the store at pricing');
    expect(run.traceEvents.some(e => e.type === 'pool:agentHeal'), 'a failed heal was announced').toBe(false);
    expect(openEntries(run)).toEqual([]);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });

  it('a heal whose lineage content is gone from the store stands down: the original\'s failure stands and the run goes on', async () => {
    const run = await healAfterPoison(shape, () => null);
    diag(`${shape} heal-content-gone`, run);
    expect(mediaFailures(run.channelEvents)).toHaveLength(1);
    expect(run.result.failure ?? null).toBe(null);
    expect(run.traceEvents.some(e => e.type === 'pool:agentHeal')).toBe(false);
    expect(run.result.outcomes.some(o => o.failed === 'media_prefill_failed'), 'the original\'s failure stands').toBe(true);
    expect(openEntries(run)).toEqual([]);
    expect(formatResult('I42', I42_noLeakedBranches(run))).toBe('I42: ok');
  });
});

// Diagnostics only (`MATRIX_DIAG=1`): how a rejected spawn request and a spawned orchestrator task
// propagate through the pool. Not assertions; the printed lines are the evidence.
describe.skipIf(!process.env.MATRIX_DIAG)('spawn throw matrix: propagation experiments', () => {
  const rejectSuffixBatch = (ctx: InstrumentedMockSessionContext): void => {
    const inner = ctx._storePrefill.bind(ctx);
    let armed = true;
    ctx._storePrefill = async (handles, tokenArrays) => {
      if (armed && handles.some(h => h !== 1)) { armed = false; throw new Error('the suffix would not prefill'); }
      return inner(handles, tokenArrays);
    };
  };
  it('E1 parallel, two spawns rejected in one batch', async () => {
    const run = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: plainScripts, policy: prose, orchestrate: parallel([spec(0), spec(1)]), captureError: true, instrument: rejectSuffixBatch });
    diag('E1', run);
  });
  it('E2 parallel, one spawn rejected', async () => {
    const run = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: plainScripts, policy: prose, orchestrate: parallel([spec(0)]), captureError: true, instrument: rejectSuffixBatch });
    diag('E2', run);
  });
  it('E3 parallel, two spawns, capacity 1 so the batch holds one request', async () => {
    const run = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: plainScripts, policy: prose, orchestrate: parallel([spec(0), spec(1)]), capacity: 1, captureError: true, instrument: rejectSuffixBatch });
    diag('E3', run);
  });
  it('E4 dag, one node whose pricing throws', async () => {
    const run = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: plainScripts, policy: prose, orchestrate: dag([{ id: 'a', task: spec(0) }]), captureError: true, instrument: (ctx) => {
      const inner = ctx.formatChatSync.bind(ctx);
      ctx.formatChatSync = (msgs, opts) => { if (msgs.includes('Task 0')) throw new Error('a throw in pricing'); return inner(msgs, opts); };
    } });
    diag('E4', run);
  });
  it('E5 parallel via all, one child whose pricing throws, the other seated', async () => {
    const run = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: plainScripts, policy: prose, orchestrate: parallel([spec(0), spec(1)]), captureError: true, instrument: (ctx) => {
      const inner = ctx.formatChatSync.bind(ctx);
      ctx.formatChatSync = (msgs, opts) => { if (msgs.includes('Task 1')) throw new Error('a throw in pricing'); return inner(msgs, opts); };
    } });
    diag('E5', run);
  });
});
