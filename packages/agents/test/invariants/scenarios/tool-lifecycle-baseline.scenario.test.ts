/**
 * B0 — the characterization baseline for the tool-lifecycle contract.
 *
 * Every test here runs a REAL pool and asserts only through the trace and the
 * agent's ledger (`toolHistory`, `attendedResults`). The assertions were written
 * against the pool BEFORE the tool-lifecycle contract and did not change when
 * the fixtures moved onto it: a stub tool now declares its own gate
 * (`hooks.beforeDispatch`) where the framework's list once named `fetch_page`,
 * and the harness re-scopes a gate by name (`guardOverrides`) where a gate once
 * rode `extraGuards`. An assertion that has to change to pass is a behaviour
 * change, and is named as one.
 *
 * Numbering follows the plan (B0.1–B0.10). B0.7 is the 24 settle-reject
 * scenarios plus the pin at the end of this file; B0.9b lives in
 * `packages/rig/test/terminal-dispatch-hole.test.ts`, because rig depends on
 * agents and not the other way round.
 */
import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped, spawn, each } from 'effection';
import type { Channel } from 'effection';
import { createMockSdk } from '../../../../sdk/src/testing.js';
import type { Tool, ToolGuard } from '../../../src/Tool';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import type { GuardOverrides } from '../../../src/AgentPolicy';
import type { AgentEvent } from '../../../src/types';
import { useAgent } from '../../../src/use-agent';
import { Ctx, Store, Events, Trace } from '../../../src/context';
import { CapturingTraceWriter } from '../../helpers/capturing-trace';
import { runPool, STOP } from '../harness';
import {
  OpenTool, ProtectedTool, FlakyTool, BigResultTool, gate, sameArg, callsOn, parse, literalPolicy, FIRST, LATER,
  nudges, dispatches, authRejects, outcomesOf, toolResults,
} from '../../helpers/lifecycle';
import type { Call } from '../../helpers/lifecycle';

// ── Fixtures local to the baseline ──────────────────────────────

/** A distinctive follow-up: 1009 chars → 253 mock tokens, unlike anything else a run prefills. */
const FOLLOW_UP = 'Reflect: ' + 'x'.repeat(1000);
/** Follows every admitted result with FOLLOW_UP. */
class FollowUpTool extends OpenTool {
  constructor(name: string) {
    super(name, { ok: true }, { afterAdmit: () => ({ type: 'followUp', message: FOLLOW_UP }) });
  }
}

/** The default policy as a harness ships it: a terminal named `report`, no minimum tool calls. */
const defaultPolicy = (extra?: { guardOverrides?: GuardOverrides }) =>
  new DefaultAgentPolicy({ terminalToolName: 'report', minToolCallsBeforeReturn: 0, ...extra });

const URL = { url: 'https://example.test/same-page' };
const fetchCall: Call = { name: 'fetch_page', arguments: JSON.stringify(URL) };

/** The stub's own gate: a URL this agent's scope already attended is refused. */
const GATE = 'same_url';
const sameUrl = sameArg(GATE, 'url', 'This URL was already attempted in this run.');

// ── B0.1–B0.3: dedup as the pool does it today ──────────────────

describe('B0 — tool-lifecycle baseline (real pool)', () => {
  it('B0.1 cohort dedup: a sibling\'s repeat of an attended URL is refused, booked as a nudge, never attended', async () => {
    // The tool declares the gate; the harness widens its scope to the cohort.
    const fetch = new OpenTool('fetch_page', { ok: true }, gate(sameUrl));
    const r = await runPool({
      scripts: [{ tokens: FIRST }, { tokens: LATER }],
      policy: defaultPolicy({ guardOverrides: { [GATE]: { scope: 'cohort' } } }),
      tools: new Map<string, Tool>([['fetch_page', fetch]]),
      terminalToolName: 'report',
      trace: true,
      instrument: parse({ t1: fetchCall, t2: fetchCall }),
    });
    const [a, b] = r.result.agents.map((x) => x.agent);
    // The tool ran once: the sibling's call never reached it.
    expect(fetch.calls).toHaveLength(1);
    expect(dispatches(r, 'fetch_page').map((d) => d.agentId)).toEqual([a.id]);
    // The refusal is on the wire, attributed to the sibling, under the gate's name.
    const n = nudges(r);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ agentId: b.id, guard: GATE });
    // The sibling's ledger books the call as a nudge and attends over nothing.
    expect(outcomesOf(r, 1, 'fetch_page')).toEqual(['nudge']);
    expect(b.attendedResults('fetch_page')).toEqual([]);
    expect(a.attendedResults('fetch_page')).toHaveLength(1);
  });

  it('B0.2 self-repeat: an agent\'s own second fetch of the same URL is refused after the first is attended', async () => {
    // Lineage scope, the default: the agent's own attended calls.
    const fetch = new OpenTool('fetch_page', { ok: true }, gate(sameUrl));
    const r = await runPool({
      scripts: [{ tokens: [1, STOP, 2, STOP, STOP] }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['fetch_page', fetch]]),
      terminalToolName: 'report',
      trace: true,
      instrument: parse({ t1: fetchCall, t2: fetchCall }),
    });
    expect(fetch.calls).toHaveLength(1);
    expect(nudges(r).map((x) => x.guard)).toEqual([GATE]);
    expect(outcomesOf(r, 0, 'fetch_page')).toEqual(['toolResult', 'nudge']);
    expect(r.result.agents[0].agent.attendedResults('fetch_page')).toHaveLength(1);
  });

  it('B0.3 an unguarded tool is never deduped: two agents, identical args, both admitted', async () => {
    const t = new OpenTool('t');
    const same: Call = { name: 't', arguments: JSON.stringify({ q: 'same' }) };
    const r = await runPool({
      scripts: [{ tokens: FIRST }, { tokens: LATER }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['t', t]]),
      terminalToolName: 'report',
      trace: true,
      instrument: parse({ t1: same, t2: same }),
    });
    expect(t.calls).toHaveLength(2);
    expect(nudges(r)).toHaveLength(0);
    expect(outcomesOf(r, 0, 't')).toEqual(['toolResult']);
    expect(outcomesOf(r, 1, 't')).toEqual(['toolResult']);
    expect(r.result.agents.map((x) => x.agent.attendedResults('t').length)).toEqual([1, 1]);
  });

  // ── B0.4–B0.5: authorization ─────────────────────────────────

  it('B0.4 grants, both branches: no grant → tool:authReject and no execute; a grant → execute, no reject', async () => {
    const bank: Call = { name: 'bank', arguments: JSON.stringify({ to: 'alice' }) };

    const denied = new ProtectedTool('bank');
    const d = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['bank', denied]]),
      terminalToolName: 'report',
      trace: true,
      instrument: parse({ t1: bank }),
    });
    expect(denied.calls).toHaveLength(0);
    expect(authRejects(d).map((x) => x.attemptedTool)).toEqual(['bank']);
    expect(outcomesOf(d, 0, 'bank')).toEqual(['nudge']);

    const granted = new ProtectedTool('bank');
    const g = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['bank', granted]]),
      terminalToolName: 'report',
      trace: true,
      grants: ['bank'],
      instrument: parse({ t1: bank }),
    });
    expect(granted.calls).toEqual([{ to: 'alice' }]);
    expect(authRejects(g)).toHaveLength(0);
    expect(outcomesOf(g, 0, 'bank')).toEqual(['toolResult']);
    expect(g.result.agents[0].agent.attendedResults('bank')).toHaveLength(1);
  });

  it('B0.5 authorization beats a gate that always rejects: the auth rejection is what the model reads', async () => {
    // The tool's own declared gate always refuses; it must still lose to auth.
    const alwaysReject: ToolGuard = { name: 'g', reject: () => true, message: 'g says no' };
    const x = new ProtectedTool('x', { ok: true }, gate(alwaysReject));
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['x', x]]),
      terminalToolName: 'report',
      trace: true,
      instrument: parse({ t1: { name: 'x', arguments: '{}' } }),
    });
    expect(x.calls).toHaveLength(0);
    expect(authRejects(r)).toHaveLength(1);
    const guards = nudges(r).map((n) => n.guard);
    expect(guards).toContain('auth_reject');
    expect(guards).not.toContain('g');

    // The gate is a live candidate, not a bystander: with the grant held, it is the one that refuses.
    const granted = new ProtectedTool('x', { ok: true }, gate(alwaysReject));
    const g = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['x', granted]]),
      terminalToolName: 'report',
      trace: true,
      grants: ['x'],
      instrument: parse({ t1: { name: 'x', arguments: '{}' } }),
    });
    expect(granted.calls).toHaveLength(0);
    expect(authRejects(g)).toHaveLength(0);
    expect(nudges(g).map((n) => n.guard)).toEqual(['g']);
  });

  // ── B0.6: retry, as the trace and the ledger see it ─────────

  it('B0.6a a transient failure parks, re-dispatches the SAME call once, is never re-gated, and books only the success', async () => {
    let gateConsulted = 0;
    const counting: ToolGuard = { name: 'count', reject: () => { gateConsulted++; return false; }, message: 'unused' };
    const flaky = new FlakyTool('flaky', 1, 5, gate(counting));
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['flaky', flaky]]),
      terminalToolName: 'report',
      trace: true,
      instrument: parse({ t1: { name: 'flaky', arguments: JSON.stringify({ q: 'x' }) } }),
    });
    // One produce, one gate consultation; two dispatches of one call.
    expect(flaky.calls).toHaveLength(2);
    expect(gateConsulted).toBe(1);
    const ds = dispatches(r, 'flaky');
    expect(ds).toHaveLength(2);
    expect(ds[0].callId).toBe(ds[1].callId);
    // While parked nothing was booked: the retry precedes the first settle.
    const retryAt = r.traceEvents.findIndex((e) => e.type === 'tool:retry');
    const settleAt = r.traceEvents.findIndex((e) => e.type === 'tool:settle_order');
    expect(retryAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeGreaterThan(retryAt);
    expect(r.channelEvents.filter((e) => e.type === 'agent:tool_retry')).toHaveLength(1);
    // The ledger holds exactly the success.
    expect(outcomesOf(r, 0, 'flaky')).toEqual(['toolResult']);
    expect(r.result.agents[0].agent.attendedResults('flaky')).toEqual([{ q: 'x' }]);
    expect(toolResults(r.channelEvents, 'flaky').map((t) => t.result).join('')).toContain('eventually');
  });

  it('B0.6b an exhausted retry books the pool-authored failure as an attended tool result', async () => {
    const flaky = new FlakyTool('flaky', 99);
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['flaky', flaky]]),
      terminalToolName: 'report',
      trace: true,
      instrument: parse({ t1: { name: 'flaky', arguments: JSON.stringify({ q: 'x' }) } }),
    });
    expect(flaky.calls).toHaveLength(2); // the default budget: one retry, then the failure settles
    expect(outcomesOf(r, 0, 'flaky')).toEqual(['toolResult']);
    expect(r.result.agents[0].agent.attendedResults('flaky')).toHaveLength(1);
    const shown = toolResults(r.channelEvents, 'flaky').map((t) => t.result).join('');
    expect(shown).toContain('currently unavailable');
  });

  // ── B0.7: the settle-reject nudge, on the wire ──────────────

  it('B0.7 a settle-reject nudge is booked under the ORIGINAL call: same agent, same callId, outcome nudge', async () => {
    const big = new BigResultTool('web_search');
    const r = await runPool({
      // Headroom (remaining 1096 − softLimit 1024 = 72) is far below the ~2000-token payload.
      nCtx: 4096,
      cellsUsed: 3000,
      scripts: [{ tokens: FIRST }],
      policy: literalPolicy({ hooks: [{ beforeAdmit: () => ({ type: 'nudge', message: 'retry' }) }] }),
      tools: new Map<string, Tool>([['web_search', big]]),
      terminalToolName: 'report',
      trace: true,
      maxTurns: 5,
      instrument: parse({ t1: { name: 'web_search', arguments: JSON.stringify({ query: 't' }) } }),
    });
    const agent = r.result.agents[0].agent;
    expect(outcomesOf(r, 0, 'web_search')).toEqual(['nudge']);
    expect(agent.attendedResults('web_search')).toEqual([]);
    const orders = r.traceEvents.filter((e) => e.type === 'tool:settle_order') as Array<{ batch: Array<{ agentId: number; callId: string }> }>;
    const booked = orders.flatMap((o) => o.batch).filter((b) => b.agentId === agent.id);
    expect(booked).toEqual([expect.objectContaining({ agentId: agent.id, callId: 'c-t1' })]);
  });

  // ── B0.8: the single-agent entry gets the same defaults ─────

  /** `useAgent` with a scripted model, draining its broadcast channel. */
  async function runUseAgent(opts: { tools: Tool[]; tokens: number[]; calls: Record<string, Call> }) {
    const { ctx, store } = createMockSdk({ nCtx: 16384, cellsUsed: 1000 });
    let i = 0;
    ctx._branchSample = () => (i < opts.tokens.length ? opts.tokens[i++] : STOP);
    ctx.parseChatOutput = callsOn(opts.calls);
    const trace = new CapturingTraceWriter();
    const events: AgentEvent[] = [];
    const agent = await run(function* () {
      yield* Ctx.set(ctx as never);
      yield* Store.set(store);
      const ch: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(ch as never);
      yield* Trace.set(trace);
      yield* spawn(function* () { for (const ev of yield* each(ch)) { events.push(ev); yield* each.next(); } });
      return yield* scoped(function* () {
        return yield* useAgent({ systemPrompt: 'You are an agent.', task: 'Task', tools: opts.tools, trace: true });
      });
    });
    return { agent, events, trace };
  }

  it('B0.8 useAgent: a protected tool without a grant is refused by the default policy the entry falls back to', async () => {
    const bank = new ProtectedTool('bank');
    const { trace } = await runUseAgent({ tools: [bank], tokens: FIRST, calls: { t1: { name: 'bank', arguments: '{}' } } });
    expect(bank.calls).toHaveLength(0);
    expect(trace.ofType('tool:authReject').map((e) => e.attemptedTool)).toEqual(['bank']);
  });

  it('B0.8 useAgent: a transient failure parks and retries under the same default', async () => {
    const flaky = new FlakyTool('flaky', 1);
    const { agent, events } = await runUseAgent({ tools: [flaky], tokens: FIRST, calls: { t1: { name: 'flaky', arguments: '{}' } } });
    expect(flaky.calls).toHaveLength(2);
    expect(events.filter((e) => e.type === 'agent:tool_retry')).toHaveLength(1);
    expect(agent.toolHistory.filter((h) => h.name === 'flaky').map((h) => h.outcome)).toEqual(['toolResult']);
  });

  // ── B0.9a: the terminal tool is intercepted, never executed ─

  it('B0.9a the terminal tool\'s execute never runs: the call is intercepted and returned', async () => {
    const report = new OpenTool('report');
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: defaultPolicy(),
      tools: new Map<string, Tool>([['report', report]]),
      terminalToolName: 'report',
      trace: true,
      instrument: parse({ t1: { name: 'report', arguments: JSON.stringify({ result: 'done' }) } }),
    });
    expect(report.calls).toHaveLength(0);
    expect(dispatches(r, 'report')).toHaveLength(0);
    const returns = r.channelEvents.filter((e) => e.type === 'agent:return') as Array<{ result: string }>;
    expect(returns.map((x) => x.result)).toEqual(['done']);
    expect(r.result.agents[0].result).toBe('done');
  });

  // ── B0.10: a follow-up that does not fit ────────────────────

  it('B0.10 a follow-up prefill that fails after its result was admitted: the result stays booked, the run dies quietly', async () => {
    // The mock never refuses capacity, so the failure is staged: the prefill
    // that carries the follow-up's tokens throws, after the tool ran.
    const look = new FollowUpTool('look');
    const followUpLen = Math.ceil(FOLLOW_UP.length / 4);
    let followUpPrefills = 0;
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: literalPolicy(),
      tools: new Map<string, Tool>([['look', look]]),
      terminalToolName: 'report',
      trace: true,
      instrument: (ctx) => {
        ctx.parseChatOutput = callsOn({ t1: { name: 'look', arguments: '{}' } });
        const orig = ctx._storePrefill.bind(ctx);
        ctx._storePrefill = async (handles, tokenArrays) => {
          if (look.calls.length > 0 && tokenArrays.some((t) => t.length === followUpLen)) {
            followUpPrefills++;
            throw Object.assign(new Error('find_slot: no KV slot for the follow-up'), { rc: 1 });
          }
          return orig(handles, tokenArrays);
        };
      },
    });
    const agent = r.result.agents[0].agent;
    // The staged failure fired exactly once, on the follow-up's own prefill.
    expect(followUpPrefills).toBe(1);
    // The result itself was admitted and booked before the follow-up ran.
    expect(look.calls).toHaveLength(1);
    expect(outcomesOf(r, 0, 'look')).toEqual(['toolResult']);
    expect(r.traceEvents.some((e) => e.type === 'branch:prefill' && (e as { role: string }).role === 'toolResult')).toBe(true);
    // The follow-up never landed...
    expect(r.traceEvents.some((e) => e.type === 'branch:prefill' && (e as { role: string }).role === 'probe')).toBe(false);
    // ...and the failure is unhandled where it happens: the tick loop's catch
    // closes the run with what exists — no agent:done for this agent, no
    // agent:failed, and no pool:close (its absence is the signal). The contract
    // moved the hook to the booking, not the delivery; this limitation stands.
    expect(r.channelEvents.some((e) => e.type === 'agent:done' && (e as { agentId: number }).agentId === agent.id)).toBe(false);
    expect(r.channelEvents.some((e) => e.type === 'agent:failed')).toBe(false);
    expect(r.traceEvents.some((e) => e.type === 'pool:close')).toBe(false);
  });
});
