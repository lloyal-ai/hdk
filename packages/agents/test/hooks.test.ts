/**
 * The frame, as pure functions: who is asked at each position, in what order,
 * and what the walk yields when nobody decides. Real `Agent`s carry the ledgers
 * a gate reads; tools are stubs that declare only what a test needs; policies
 * are literals, or the default policy where its own entry is the subject. No
 * pool, no store.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { ParsedToolCall } from '@lloyal-labs/sdk';
import { Agent } from '../src/Agent';
import type { ToolHistoryEntry } from '../src/Agent';
import { Tool, ToolRetryError } from '../src/Tool';
import type { Completion, ToolGuard, ToolLifecycleHooks } from '../src/Tool';
import { DefaultAgentPolicy } from '../src/AgentPolicy';
import type { AgentPolicy } from '../src/AgentPolicy';
import { ContextPressure } from '../src/pressure';
import {
  makeFrame, decideBeforeDispatch, decideAfterExecute, decideBeforeAdmit, decideAfterAdmit,
  AUTH_REJECT_GUARD, DEFAULT_MAX_TOOL_RETRIES,
} from '../src/hooks';
import type { Frame } from '../src/hooks';
import type { JsonSchema } from '../src/types';
import { createMockBranch } from './helpers/mock-branch';
import { FMT } from './helpers/format-config';

// ── Fixtures ────────────────────────────────────────────────────

class Stub extends Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description = 'stub';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  constructor(name: string, readonly hooks?: ToolLifecycleHooks) { super(); this.name = name; }
  *execute(): Operation<unknown> { return {}; }
}
const gate = (name: string, reject: ToolGuard['reject'], message = `${name} says no`): ToolGuard => ({ name, reject, message });
const always = (name: string) => gate(name, () => true);

let nextId = 1;
/** A real agent; with a parent, a member of that lineage. */
const agent = (parent: Agent | null = null): Agent => {
  const id = nextId++;
  return new Agent({ id, parentId: parent?.id ?? 0, branch: createMockBranch({ handle: id }) as never, parent, fmt: FMT });
};
const entry = (name: string, args: object, outcome: ToolHistoryEntry['outcome'] = 'toolResult'): ToolHistoryEntry =>
  ({ name, args: JSON.stringify(args), resultCells: 0, contextAfterPercent: 100, timestamp: 0, outcome });
const call = (name: string, args: object = {}): ParsedToolCall => ({ name, arguments: JSON.stringify(args), id: 'c' });
const literal = (over: Partial<AgentPolicy> = {}): AgentPolicy =>
  ({ onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }), ...over });
/** The frame with nothing protected. */
const open: Frame = makeFrame({ protectedTools: new Set(), grants: new Set() });
const pressure = (remaining = 5000, nCtx = 16384) =>
  new ContextPressure({ nCtx, cellsUsed: nCtx - remaining, remaining }, { softLimit: 1024, hardLimit: 128 });

const gateOn = (tc: ParsedToolCall, o: { agent?: Agent; roster?: Agent[]; tool?: Tool; policy?: AgentPolicy; frame?: Frame } = {}) => {
  const a = o.agent ?? agent();
  return decideBeforeDispatch({ tc, agent: a, roster: o.roster ?? [a], frame: o.frame ?? open, tool: o.tool, policy: o.policy ?? literal() });
};
const threw = (error: Error): Completion => ({ kind: 'threw', error });
const returned = (value: unknown = {}): Completion => ({ kind: 'returned', value });
const transient = () => threw(new ToolRetryError('rate limited', 30));

// ── beforeDispatch ──────────────────────────────────────────────

describe('beforeDispatch: the gates', () => {
  it('a tool-declared gate refuses, under its own name', () => {
    const t = new Stub('t', { beforeDispatch: [always('g')] });
    expect(gateOn(call('t'), { tool: t })).toEqual({ decision: { guard: 'g', message: 'g says no' }, by: 'tool' });
  });

  it('nobody refuses: no decision', () => {
    expect(gateOn(call('t'), { tool: new Stub('t') })).toBeUndefined();
  });

  it("the frame's gate (authorization) beats a rejecting tool gate; a grant hands the call to the tool's gate", () => {
    const t = new Stub('t', { beforeDispatch: [always('g')] });
    const locked = makeFrame({ protectedTools: new Set(['t']), grants: new Set() });
    expect(gateOn(call('t'), { tool: t, frame: locked })).toMatchObject({ decision: { guard: AUTH_REJECT_GUARD }, by: 'frame' });
    const granted = makeFrame({ protectedTools: new Set(['t']), grants: new Set(['t']) });
    expect(gateOn(call('t'), { tool: t, frame: granted })).toMatchObject({ decision: { guard: 'g' }, by: 'tool' });
  });

  it("the called tool's gate precedes a policy gate", () => {
    const t = new Stub('t', { beforeDispatch: [always('tool_gate')] });
    const p = literal({ hooks: [{ beforeDispatch: [always('policy_gate')] }] });
    expect(gateOn(call('t'), { tool: t, policy: p })).toMatchObject({ decision: { guard: 'tool_gate' }, by: 'tool' });
  });

  it('a policy gate is consulted for every tool and selects by `i.tool`', () => {
    const seen: string[] = [];
    const p = literal({ hooks: [{ beforeDispatch: [gate('audit', (i) => { seen.push(i.tool); return i.tool === 'beta'; })] }] });
    expect(gateOn(call('alpha'), { policy: p })).toBeUndefined();
    expect(gateOn(call('beta'), { policy: p })).toMatchObject({ decision: { guard: 'audit' }, by: 'policy' });
    expect(seen).toEqual(['alpha', 'beta']);
  });

  it('guardOverrides: `false` switches a tool gate off; the frame\'s gate is not overridable', () => {
    const t = new Stub('t', { beforeDispatch: [always('g')] });
    expect(gateOn(call('t'), { tool: t, policy: literal({ guardOverrides: { g: false } }) })).toBeUndefined();
    const locked = makeFrame({ protectedTools: new Set(['t']), grants: new Set() });
    expect(gateOn(call('t'), { tool: t, frame: locked, policy: literal({ guardOverrides: { [AUTH_REJECT_GUARD]: false, g: false } }) }))
      .toMatchObject({ decision: { guard: AUTH_REJECT_GUARD }, by: 'frame' });
  });

  describe('attended(): what a gate sees', () => {
    const sameQ = gate('same_q', ({ args, attended }) => attended().some((a) => a.q === args.q));
    const t = new Stub('t', { beforeDispatch: [sameQ] });
    /** A parent that attended q=1, its child, and a sibling with an empty ledger. */
    const family = () => {
      const parent = agent();
      parent.recordToolResult(entry('t', { q: 1 }));
      const child = agent(parent);
      const sibling = agent();
      return { parent, child, sibling, roster: [parent, child, sibling] };
    };

    it('lineage is the default: the agent and its ancestors, never a sibling', () => {
      const { child, sibling, roster } = family();
      expect(gateOn(call('t', { q: 1 }), { tool: t, agent: child, roster })).toMatchObject({ decision: { guard: 'same_q' } });
      expect(gateOn(call('t', { q: 1 }), { tool: t, agent: sibling, roster })).toBeUndefined();
      expect(gateOn(call('t', { q: 2 }), { tool: t, agent: child, roster })).toBeUndefined();
    });

    it('`{ scope: cohort }` reads the whole roster', () => {
      const { sibling, roster } = family();
      const cohort = literal({ guardOverrides: { same_q: { scope: 'cohort' } } });
      expect(gateOn(call('t', { q: 1 }), { tool: t, agent: sibling, roster, policy: cohort })).toMatchObject({ decision: { guard: 'same_q' } });
    });

    it('a nudged entry is not attended, in either scope', () => {
      const a = agent();
      a.recordToolResult(entry('t', { q: 1 }, 'nudge'));
      expect(gateOn(call('t', { q: 1 }), { tool: t, agent: a })).toBeUndefined();
      const cohort = literal({ guardOverrides: { same_q: { scope: 'cohort' } } });
      expect(gateOn(call('t', { q: 1 }), { tool: t, agent: a, roster: [a], policy: cohort })).toBeUndefined();
    });

    it('is projected to the gated tool: another tool\'s q=1 does not count', () => {
      const a = agent();
      a.recordToolResult(entry('other', { q: 1 }));
      expect(gateOn(call('t', { q: 1 }), { tool: t, agent: a })).toBeUndefined();
    });

    it('a gate named like an Object.prototype member stays lineage-scoped: the override lookup reads own keys only', () => {
      const { parent, sibling, roster } = family();
      void parent;
      for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
        const t = new Stub('t', { beforeDispatch: [gate(name, ({ args, attended }) => attended().some((a) => a.q === args.q))] });
        expect(gateOn(call('t', { q: 1 }), { tool: t, agent: sibling, roster }), name).toBeUndefined();
        expect(gateOn(call('t', { q: 1 }), { tool: t, agent: sibling, roster, policy: literal({ guardOverrides: { other: false } }) }), name).toBeUndefined();
      }
    });

    it('is computed once per scope, and not at all when no gate asks', () => {
      const a = agent();
      let walks = 0;
      const orig = a.walkAncestors.bind(a);
      a.walkAncestors = ((fn) => { walks++; return orig(fn); }) as Agent['walkAncestors'];
      const twice = gate('twice', (i) => { i.attended(); i.attended(); return false; });
      const once = gate('once', (i) => { i.attended(); return false; });
      gateOn(call('t'), { tool: new Stub('t', { beforeDispatch: [twice] }), agent: a, policy: literal({ hooks: [{ beforeDispatch: [once] }] }) });
      expect(walks).toBe(1);
      walks = 0;
      gateOn(call('t'), { tool: new Stub('t', { beforeDispatch: [always('g')] }), agent: a });
      expect(walks).toBe(0);
    });
  });

  it('malformed, null or non-object arguments reach a gate as an empty record, not a throw', () => {
    const readsUrl = gate('url', ({ args, attended }) => typeof args.url === 'string' || attended().some((a) => typeof a.url === 'string'));
    const a = agent();
    a.recordToolResult(entry('t', {} as object));
    a.toolHistory[0].args = 'null';   // a booked call whose arguments were the JSON scalar `null`
    for (const raw of ['not json', 'null', '[]', '5', '"x"', 'true']) {
      const tc: ParsedToolCall = { name: 't', arguments: raw, id: 'c' };
      expect(gateOn(tc, { tool: new Stub('t', { beforeDispatch: [readsUrl] }), agent: a }), raw).toBeUndefined();
    }
  });
});

// ── afterExecute ────────────────────────────────────────────────

describe('afterExecute: the completion', () => {
  const a = agent();
  const input = (completion: Completion, attempt = 1) => ({ agent: a, tool: 't', args: {}, attempt, completion });

  it("a tool hook beats the policy's entry beats the frame's default", () => {
    const t = new Stub('t', { afterExecute: () => ({ type: 'fail', message: 'tool' }) });
    const p = literal({ hooks: [{ afterExecute: () => ({ type: 'fail', message: 'policy' }) }] });
    expect(decideAfterExecute(input(transient()), { frame: open, tool: t, policy: p })).toEqual({ decision: { type: 'fail', message: 'tool' }, by: 'tool' });
    expect(decideAfterExecute(input(transient()), { frame: open, tool: new Stub('t'), policy: p })).toEqual({ decision: { type: 'fail', message: 'policy' }, by: 'policy' });
    expect(decideAfterExecute(input(transient()), { frame: open, tool: new Stub('t'), policy: literal() })).toEqual({ decision: { type: 'retry', afterMs: 30 }, by: 'frame' });
  });

  it(`the frame default retries a transient failure ${DEFAULT_MAX_TOOL_RETRIES} time(s) at the tool's delay, then fails saying why`, () => {
    const c = { frame: open, tool: undefined, policy: literal() };
    expect(decideAfterExecute(input(transient(), DEFAULT_MAX_TOOL_RETRIES), c)).toEqual({ decision: { type: 'retry', afterMs: 30 }, by: 'frame' });
    // The decision that knows why carries the message: the rate-limit text names the tool.
    expect(decideAfterExecute(input(transient(), DEFAULT_MAX_TOOL_RETRIES + 1), c)).toEqual({
      decision: { type: 'fail', message: expect.stringMatching(/^t is currently unavailable \(rate-limited; retry failed\)/) }, by: 'frame',
    });
  });

  it('the frame default counts any other throw, and a return, as an attempt', () => {
    const c = { frame: open, tool: undefined, policy: literal() };
    expect(decideAfterExecute(input(threw(new Error('boom'))), c)).toEqual({ decision: { type: 'attempt' }, by: 'frame' });
    expect(decideAfterExecute(input(returned({ ok: true })), c)).toEqual({ decision: { type: 'attempt' }, by: 'frame' });
  });

  it("the default policy's entry is its retry budget: retryUpTo(maxToolRetries)", () => {
    const c = { frame: open, tool: undefined, policy: new DefaultAgentPolicy({ maxToolRetries: 3 }) };
    expect(decideAfterExecute(input(transient(), 3), c)).toEqual({ decision: { type: 'retry', afterMs: 30 }, by: 'policy' });
    expect(decideAfterExecute(input(transient(), 4), c)).toMatchObject({ decision: { type: 'fail', message: expect.stringContaining('rate-limited') }, by: 'policy' });
    expect(decideAfterExecute(input(returned()), c)).toEqual({ decision: { type: 'attempt' }, by: 'frame' });
  });
});

// ── beforeAdmit ─────────────────────────────────────────────────

describe('beforeAdmit: a result that does not fit', () => {
  const withCalls = (n: number) => { const a = agent(); for (let i = 0; i < n; i++) a.incrementToolCalls(); return a; };
  const input = (a: Agent, terminal?: string, remaining = 5000) => ({ agent: a, tool: 't', args: {}, cost: 5000, pressure: pressure(remaining), terminal });

  it('the frame default drops', () => {
    expect(decideBeforeAdmit(input(withCalls(3), 'report'), { frame: open, tool: undefined, policy: literal() })).toEqual({ decision: { type: 'drop' }, by: 'frame' });
  });

  describe("the default policy's entry", () => {
    const c = (policy: AgentPolicy = new DefaultAgentPolicy()) => ({ frame: open, tool: undefined, policy });

    it('nudges when a terminal tool exists and the agent has called a tool', () => {
      const r = decideBeforeAdmit(input(withCalls(3), 'report'), c());
      expect(r.by).toBe('policy');
      expect(r.decision.type).toBe('nudge');
      expect((r.decision as { message: string }).message).toContain('Tool result too large');
    });

    it('drops when there is no terminal tool', () => {
      expect(decideBeforeAdmit(input(withCalls(3)), c())).toEqual({ decision: { type: 'drop' }, by: 'policy' });
    });

    it('drops when the agent has called nothing yet', () => {
      expect(decideBeforeAdmit(input(withCalls(0), 'report'), c())).toEqual({ decision: { type: 'drop' }, by: 'policy' });
    });

    it('caps the advertised budget at 1200 words', () => {
      // pressure(remaining=5000, hardLimit=128) → 4872 tokens → 3410 words uncapped; the advisory caps at 1200.
      expect(decideBeforeAdmit(input(withCalls(2), 'report'), c()).decision).toEqual({
        type: 'nudge',
        message: 'Tool result too large for the remaining context. Report your findings now within 1200 words.',
      });
    });

    it('a harness entry on the same policy precedes it', () => {
      const p = new DefaultAgentPolicy({ hooks: [{ beforeAdmit: () => ({ type: 'nudge', message: 'mine' }) }] });
      expect(decideBeforeAdmit(input(withCalls(3), 'report'), c(p))).toEqual({ decision: { type: 'nudge', message: 'mine' }, by: 'policy' });
    });

    it("a tool's beforeAdmit precedes both", () => {
      const t = new Stub('t', { beforeAdmit: () => ({ type: 'drop' }) });
      expect(decideBeforeAdmit(input(withCalls(3), 'report'), { frame: open, tool: t, policy: new DefaultAgentPolicy() })).toEqual({ decision: { type: 'drop' }, by: 'tool' });
    });
  });
});

// ── afterAdmit ──────────────────────────────────────────────────

describe('afterAdmit: the follow-up', () => {
  const a = agent();
  const input = { agent: a, tool: 't', args: {}, outcome: 'toolResult' as const, result: { ok: true } };

  it('tool, then policy; the frame default is none', () => {
    const t = new Stub('t', { afterAdmit: () => ({ type: 'followUp', message: 'tool says' }) });
    const p = literal({ hooks: [{ afterAdmit: () => ({ type: 'followUp', message: 'policy says' }) }] });
    expect(decideAfterAdmit(input, { frame: open, tool: t, policy: p })).toEqual({ decision: { type: 'followUp', message: 'tool says' }, by: 'tool' });
    expect(decideAfterAdmit(input, { frame: open, tool: new Stub('t'), policy: p })).toEqual({ decision: { type: 'followUp', message: 'policy says' }, by: 'policy' });
    expect(decideAfterAdmit(input, { frame: open, tool: new Stub('t'), policy: literal() })).toEqual({ decision: { type: 'none' }, by: 'frame' });
  });

  it('`{ type: none }` is a decision: it ends the walk; `undefined` abstains', () => {
    const none = new Stub('t', { afterAdmit: () => ({ type: 'none' }) });
    const abstains = new Stub('t', { afterAdmit: () => undefined });
    const p = literal({ hooks: [{ afterAdmit: () => ({ type: 'followUp', message: 'policy says' }) }] });
    expect(decideAfterAdmit(input, { frame: open, tool: none, policy: p })).toEqual({ decision: { type: 'none' }, by: 'tool' });
    expect(decideAfterAdmit(input, { frame: open, tool: abstains, policy: p })).toEqual({ decision: { type: 'followUp', message: 'policy says' }, by: 'policy' });
  });
});
