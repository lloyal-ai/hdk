/**
 * The tool-lifecycle contract on a real pool: pins of the behaviour the
 * contract ADDED, beside the B0 baseline that pins what it preserved. Every
 * test asserts only through the trace and the agent's ledger.
 */
import { describe, it, expect } from 'vitest';
import { sleep } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import type { ToolGuard, ToolLifecycleHooks } from '../../../src/Tool';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { JsonSchema } from '../../../src/types';
import { runPool, STOP } from '../harness';
import { I43_attendedIsAdmitted, formatResult } from '../predicates';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX } from '../../helpers/media';
import {
  OpenTool, FlakyTool, BigResultTool, gate, sameArg, callsOn, parse, literalPolicy, FIRST, LATER,
  nudges, dispatches, outcomesOf, prefillRoles, settled,
} from '../../helpers/lifecycle';
import type { Call } from '../../helpers/lifecycle';

const always = (name: string): ToolGuard => ({ name, reject: () => true, message: `${name} says no` });
const sameQ = sameArg('same_q', 'q');
const call = (q: string): Call => ({ name: 't', arguments: JSON.stringify({ q }) });
const only = (t: Tool) => new Map<string, Tool>([[t.name, t]]);

describe('tool-lifecycle contract (real pool)', () => {
  it("a literal policy with no hooks: a stub tool's declared gate is enforced, and the nudge is announced as a nudge", async () => {
    const t = new OpenTool('t', { ok: true }, gate(always('g')));
    const r = await runPool({
      scripts: [{ tokens: FIRST }], policy: literalPolicy(), tools: only(t), trace: true, instrument: parse({ t1: call('x') }),
    });
    expect(t.calls).toHaveLength(0);
    expect(dispatches(r)).toHaveLength(0);
    expect(nudges(r)).toEqual([expect.objectContaining({ guard: 'g', message: 'g says no', tool: 't' })]);
    expect(outcomesOf(r, 0, 't')).toEqual(['nudge']);
    // Trace honesty: the admitted nudge is a nudge on both records, never a toolResult.
    expect(prefillRoles(r)).toContain('nudge');
    expect(prefillRoles(r)).not.toContain('toolResult');
    expect(settled(r).map((s) => s.kind)).toEqual(['nudge']);
  });

  it('the off switch: guardOverrides { g: false } admits the call', async () => {
    const t = new OpenTool('t', { ok: true }, gate(always('g')));
    const r = await runPool({
      scripts: [{ tokens: FIRST }], policy: literalPolicy({ guardOverrides: { g: false } }), tools: only(t), trace: true,
      instrument: parse({ t1: call('x') }),
    });
    expect(t.calls).toEqual([{ q: 'x' }]);
    expect(nudges(r)).toHaveLength(0);
    expect(settled(r).map((s) => s.kind)).toEqual(['toolResult']);
    expect(prefillRoles(r).filter((role) => role === 'toolResult')).toHaveLength(1);
  });

  it('isolation under the lineage default: two agents, the same arguments, both admitted', async () => {
    const t = new OpenTool('t', { ok: true }, gate(sameQ));
    const r = await runPool({
      scripts: [{ tokens: FIRST }, { tokens: LATER }], policy: literalPolicy(), tools: only(t), trace: true,
      instrument: parse({ t1: call('same'), t2: call('same') }),
    });
    expect(t.calls).toHaveLength(2);
    expect(nudges(r)).toHaveLength(0);
    expect(r.result.agents.map((x) => x.agent.attendedResults('t'))).toEqual([[{ q: 'same' }], [{ q: 'same' }]]);
  });

  it("re-scoped to the cohort by the harness: the sibling's repeat is refused under the gate's name", async () => {
    const t = new OpenTool('t', { ok: true }, gate(sameQ));
    const r = await runPool({
      scripts: [{ tokens: FIRST }, { tokens: LATER }],
      policy: literalPolicy({ guardOverrides: { same_q: { scope: 'cohort' } } }),
      tools: only(t), trace: true, instrument: parse({ t1: call('same'), t2: call('same') }),
    });
    const [a, b] = r.result.agents.map((x) => x.agent);
    expect(t.calls).toHaveLength(1);
    expect(nudges(r)).toEqual([expect.objectContaining({ agentId: b.id, guard: 'same_q' })]);
    expect(a.attendedResults('t')).toHaveLength(1);
    expect(b.attendedResults('t')).toEqual([]);
    expect(outcomesOf(r, 1, 't')).toEqual(['nudge']);
  });

  it('a tool gate precedes a policy gate', async () => {
    const t = new OpenTool('t', { ok: true }, gate(always('tool_gate')));
    const r = await runPool({
      scripts: [{ tokens: FIRST }], policy: literalPolicy({ hooks: [{ beforeDispatch: [always('policy_gate')] }] }),
      tools: only(t), trace: true, instrument: parse({ t1: call('x') }),
    });
    expect(nudges(r).map((n) => n.guard)).toEqual(['tool_gate']);
  });

  it("an over-budget duplicate gets the gate's nudge, not the budget nudge (gates before budget)", async () => {
    const t = new OpenTool('t', { ok: true }, gate(sameQ));
    const r = await runPool({
      scripts: [{ tokens: [1, STOP, 2, STOP, STOP] }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report', minToolCallsBeforeReturn: 0 }),
      tools: only(t), terminalToolName: 'report', maxTurns: 1, trace: true,
      instrument: parse({ t1: call('same'), t2: call('same') }),
    });
    expect(t.calls).toHaveLength(1);
    const n = nudges(r);
    expect(n.map((x) => x.guard)).toEqual(['same_q']);
    expect(n[0].message).not.toContain('Turn limit');
    expect(outcomesOf(r, 0, 't')).toEqual(['toolResult', 'nudge']);
  });

  it("afterAdmit precedence: the tool's follow-up is prefilled, not the policy's", async () => {
    const t = new OpenTool('t', { ok: true }, { afterAdmit: () => ({ type: 'followUp', message: 'tool says' }) });
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: literalPolicy({ hooks: [{ afterAdmit: () => ({ type: 'followUp', message: 'policy says' }) }] }),
      tools: only(t), trace: true, instrument: parse({ t1: call('x') }),
    });
    const followUps = r.traceEvents.filter((e) => e.type === 'branch:prefill' && (e as { role: string }).role === 'probe') as Array<{ probeText?: string }>;
    expect(followUps.map((f) => f.probeText)).toEqual(['tool says']);
  });
});

// ── afterAdmit: when it runs, what it is shown ──────────────────

type Seen = { outcome: string; result: unknown; attendedNow: number };
/** A tool whose `afterAdmit` records what it was shown — and how many of its own
 *  results the agent had attended at that moment — then abstains. */
const recording = (name: string, seen: Seen[], extra: Partial<ToolLifecycleHooks> = {}) =>
  new OpenTool(name, { ok: true }, {
    ...extra,
    afterAdmit: ({ agent, outcome, result }) => {
      seen.push({ outcome, result, attendedNow: agent.attendedResults(name).length });
      return undefined;
    },
  });

describe('afterAdmit runs at the booking, once per admitted item, with what the agent received', () => {
  it("a tool result: once, after the result is attended, with the tool's value (and the framework's meter)", async () => {
    const seen: Seen[] = [];
    const t = recording('t', seen);
    await runPool({ scripts: [{ tokens: FIRST }], policy: literalPolicy(), tools: only(t), trace: true, instrument: parse({ t1: call('x') }) });
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe('toolResult');
    expect(seen[0].result).toMatchObject({ ok: true, _contextAvailablePercent: expect.any(Number) });
    expect(seen[0].attendedNow).toBe(1);
  });

  it("a guard nudge: with outcome nudge and the gate's message as the { error } the model reads", async () => {
    const seen: Seen[] = [];
    const t = recording('t', seen, gate(always('g')));
    const r = await runPool({ scripts: [{ tokens: FIRST }], policy: literalPolicy(), tools: only(t), trace: true, instrument: parse({ t1: call('x') }) });
    expect(nudges(r).map((n) => n.guard)).toEqual(['g']);
    expect(seen).toEqual([{ outcome: 'nudge', result: { error: 'g says no' }, attendedNow: 0 }]);
  });

  it('a stall replacement: at the nudge\'s own booking, with the same payload shape', async () => {
    const seen: Seen[] = [];
    class Big extends BigResultTool {
      readonly hooks: ToolLifecycleHooks = {
        afterAdmit: ({ agent, outcome, result }) => { seen.push({ outcome, result, attendedNow: agent.attendedResults('web_search').length }); return undefined; },
      };
    }
    const r = await runPool({
      nCtx: 4096, cellsUsed: 3000, scripts: [{ tokens: FIRST }],
      policy: literalPolicy({ hooks: [{ beforeAdmit: () => ({ type: 'nudge', message: 'retry' }) }] }),
      tools: only(new Big('web_search')), terminalToolName: 'report', trace: true, maxTurns: 5,
      instrument: parse({ t1: { name: 'web_search', arguments: JSON.stringify({ query: 't' }) } }),
    });
    expect(outcomesOf(r, 0, 'web_search')).toEqual(['nudge']);
    expect(seen).toEqual([{ outcome: 'nudge', result: { error: 'retry' }, attendedNow: 0 }]);
  });

  it("a wind-down abandon item: booked as the tool's result, the hook sees its { error }", async () => {
    const seen: Seen[] = [];
    class Flaky extends FlakyTool {
      readonly hooks: ToolLifecycleHooks = {
        afterAdmit: ({ agent, outcome, result }) => { seen.push({ outcome, result, attendedNow: agent.attendedResults('flaky').length }); return undefined; },
      };
    }
    const r = await runPool({
      scripts: [{ tokens: FIRST }], policy: literalPolicy(), tools: only(new Flaky('flaky', 99, 60_000)), trace: true,
      windDownAfter: (ev) => ev.type === 'agent:tool_retry',
      instrument: parse({ t1: { name: 'flaky', arguments: '{}' } }),
    });
    expect(outcomesOf(r, 0, 'flaky')).toEqual(['toolResult']);
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe('toolResult');
    expect(seen[0].result).toEqual({ error: expect.stringContaining('winding down') });
    expect(seen[0].attendedNow).toBe(1);
  });

  it('a recovery prompt asks nothing: neither a policy hook nor a tool named `recovery` is consulted', async () => {
    const policySeen: string[] = [];
    const toolSeen: Seen[] = [];
    const t = new OpenTool('t');
    const impostor = recording('recovery', toolSeen);
    const policy: AgentPolicy = literalPolicy({
      onProduced: (_a, parsed) => {
        const tc = parsed.toolCalls[0];
        if (tc?.name === 't') return { type: 'tool_call', tc };
        return { type: 'idle', reason: 'max_turns' };
      },
      onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
      hooks: [{ afterAdmit: ({ outcome }) => { policySeen.push(outcome); return undefined; } }],
    });
    const r = await runPool({
      scripts: [{ tokens: [1, STOP, 2, STOP, STOP] }], policy,
      tools: new Map<string, Tool>([['t', t], ['recovery', impostor]]), trace: true,
      instrument: parse({ t1: call('x'), t2: { name: 'nothing', arguments: '{}' } }),
    });
    expect(prefillRoles(r)).toContain('recovery');
    expect(settled(r).map((s) => s.kind)).toEqual(['toolResult', 'recovery']);
    expect(policySeen).toEqual(['toolResult']);
    expect(toolSeen).toEqual([]);
  });

  it('a hook that throws: the result stays booked and attended, no follow-up, a tool:error record, the run completes', async () => {
    const t = new OpenTool('t', { ok: true }, { afterAdmit: () => { throw new Error('hook exploded'); } });
    const r = await runPool({ scripts: [{ tokens: FIRST }], policy: literalPolicy(), tools: only(t), trace: true, instrument: parse({ t1: call('x') }) });
    expect(outcomesOf(r, 0, 't')).toEqual(['toolResult']);
    expect(r.result.agents[0].agent.attendedResults('t')).toHaveLength(1);
    expect(prefillRoles(r)).toContain('toolResult');
    expect(prefillRoles(r)).not.toContain('probe');
    const errors = r.traceEvents.filter((e) => e.type === 'tool:error') as Array<{ tool: string; error: string }>;
    expect(errors).toEqual([expect.objectContaining({ tool: 't', error: expect.stringContaining('hook exploded') })]);
    expect(r.channelEvents.some((e) => e.type === 'agent:done')).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('a dropped item never asks: the frame drops it at the stall-break and no hook runs', async () => {
    const seen: Seen[] = [];
    class Big extends BigResultTool {
      readonly hooks: ToolLifecycleHooks = { afterAdmit: ({ outcome, result }) => { seen.push({ outcome, result, attendedNow: 0 }); return undefined; } };
    }
    const r = await runPool({
      nCtx: 4096, cellsUsed: 3000, scripts: [{ tokens: FIRST }], policy: literalPolicy(),
      tools: only(new Big('web_search')), trace: true, maxTurns: 5,
      instrument: parse({ t1: { name: 'web_search', arguments: JSON.stringify({ query: 't' }) } }),
    });
    const drops = r.traceEvents.filter((e) => e.type === 'pool:agentDrop') as Array<{ reason: string }>;
    expect(drops.map((d) => d.reason)).toEqual(['settle_stall_break']);
    expect(seen).toEqual([]);
    expect(outcomesOf(r, 0, 'web_search')).toEqual([]);
  });

  it('a deferred item asks once, when it finally books — not while it waits', async () => {
    // The shape of `stall-break-waits-for-in-flight-sibling`: A's result is
    // larger than the headroom while B is alive and fits once B has returned
    // and been pruned; B is awaiting a slow fan-out tool when A's result arrives.
    const seen: Seen[] = [];
    class SlowFanout extends Tool<Record<string, unknown>> {
      readonly name = 'slow_search';
      readonly description = 'sleeps off the loop, then returns a small result';
      readonly parameters: JsonSchema = { type: 'object', properties: {} };
      readonly fanout = true;
      *execute(): Operation<unknown> { yield* sleep(60); return { results: ['ok'] }; }
    }
    class Sized extends OpenTool {
      constructor() { super('web_search', { results: ['x'.repeat(700)] }, {
        afterAdmit: ({ agent, outcome, result }) => { seen.push({ outcome, result, attendedNow: agent.attendedResults('web_search').length }); return undefined; },
      }); }
    }
    const policy: AgentPolicy = literalPolicy({
      onProduced: (agent, parsed) => parsed.toolCalls.length > 0 && agent.toolCallCount === 0
        ? { type: 'tool_call', tc: parsed.toolCalls[0] }
        : { type: 'idle', reason: 'free_text_stop' },
      hooks: [{ beforeAdmit: () => ({ type: 'nudge', message: 'Tool result too large. Report now.' }) }],
    });
    const r = await runPool({
      nCtx: 1288, cellsUsed: 0,
      scripts: [
        { tokens: [1, STOP], toolCall: { name: 'web_search', arguments: '{}', id: 'a1' } },
        { tokens: [1, STOP], toolCall: { name: 'slow_search', arguments: '{}', id: 'b1' } },
      ],
      tools: new Map<string, Tool>([['web_search', new Sized()], ['slow_search', new SlowFanout()]]),
      policy, taskCount: 2, trace: true,
    });
    expect(nudges(r)).toEqual([]);
    expect(r.traceEvents.filter((e) => e.type === 'pool:agentDrop')).toEqual([]);
    const [a, b] = r.result.agents.map((x) => x.agentId);
    const events = r.traceEvents as Array<{ type: string; branchHandle?: number; role?: string }>;
    const bPruned = events.findIndex((e) => e.type === 'branch:prune' && e.branchHandle === b);
    const aLanded = events.findIndex((e) => e.type === 'branch:prefill' && e.role === 'toolResult' && e.branchHandle === a);
    expect(aLanded).toBeGreaterThan(bPruned);
    // Deferred across ticks, asked exactly once, after it was attended.
    expect(seen).toEqual([{ outcome: 'toolResult', result: expect.objectContaining({ results: [expect.any(String)] }), attendedNow: 1 }]);
  });
});

// ── heal under cohort scope ──────────────────────────────────────

describe('a heal under cohort scope', () => {
  it("the cohort holds the original's and the replacement's entries; a cohort gate still refuses exactly as before; I43 counts the lineage once", async () => {
    const look = new OpenTool('look', { ok: true }, gate(sameArg('same_q', 'q')));
    const r = await runPool({
      nCtx: MEDIA_TEST_NCTX,
      // A: look, then a poisoned media call (rc −3) → healed; S: look with the same q, later; R (the replacement): done.
      scripts: [{ tokens: [1, STOP, 2, STOP, STOP] }, { tokens: [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 3, STOP, STOP] }, { tokens: [STOP] }],
      taskCount: 2,
      policy: literalPolicy({ guardOverrides: { same_q: { scope: 'cohort' } } }),
      tools: new Map<string, Tool>([['look', look], ['rasterize', new MediaTool([PNG_BYTES])]]),
      trace: true,
      instrument: (ctx) => {
        const lookX: Call = { name: 'look', arguments: JSON.stringify({ q: 'x' }) };
        ctx.parseChatOutput = callsOn({ t1: lookX, t2: { name: 'rasterize', arguments: '{}' }, t3: lookX });
        let seen = 0;
        ctx.mockMultimodalError = () => (seen++ === 0 ? { message: 'compute failed', rc: -3 } : null);
      },
    });
    const heals = r.traceEvents.filter((e) => e.type === 'pool:agentHeal') as Array<{ of: number; agentId: number }>;
    expect(heals).toHaveLength(1);
    const replacement = r.result.agents.find((x) => x.agentId === heals[0].agentId)!.agent;
    const sibling = r.result.agents[1].agent;
    // The replacement's ledger carries the original's attended look.
    expect(replacement.attendedResults('look')).toEqual([{ q: 'x' }]);
    // The sibling's repeat is refused by the cohort gate — once, whatever the duplicate in the roster.
    expect(look.calls).toHaveLength(1);
    expect(nudges(r)).toEqual([expect.objectContaining({ agentId: sibling.id, guard: 'same_q' })]);
    expect(sibling.attendedResults('look')).toEqual([]);
    expect(formatResult('I43', I43_attendedIsAdmitted(r))).toBe('I43: ok');
  });
});
