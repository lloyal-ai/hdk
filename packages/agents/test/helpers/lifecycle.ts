/**
 * Fixtures for the tool-lifecycle tests: stub tools that record their calls
 * and may declare hooks, a parser keyed off the raw turn text, a literal
 * policy, the two scripts, and the trace/ledger projections the assertions
 * read. Shared by the B0 baseline, the contract scenarios and the pool-level
 * authorization tests, so the three speak one vocabulary.
 */
import type { Operation } from 'effection';
import type { ChatFormat, ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { Tool, ToolRetryError } from '../../src/Tool';
import type { ToolGuard, ToolLifecycleHooks } from '../../src/Tool';
import type { AgentPolicy } from '../../src/AgentPolicy';
import type { AgentEvent, JsonSchema } from '../../src/types';
import type { PoolRun, InstrumentedMockSessionContext } from '../invariants/harness';
import { STOP } from '../invariants/harness';

/** A tool's hooks from its one gate. */
export const gate = (g: ToolGuard): ToolLifecycleHooks => ({ beforeDispatch: [g] });

/** A gate that refuses a call whose `key` argument this scope already attended. */
export const sameArg = (name: string, key: string, message = `${key} already attempted in this run.`): ToolGuard => ({
  name,
  reject: ({ args, attended }) => attended().some((a) => a[key] === args[key]),
  message,
});

/** A tool that records what it was called with and returns a small value; it may declare hooks. */
export class OpenTool extends Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description = 'stub tool';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  calls: Record<string, unknown>[] = [];
  constructor(name: string, private readonly result: unknown = { ok: true }, readonly hooks?: ToolLifecycleHooks) {
    super();
    this.name = name;
  }
  *execute(args: Record<string, unknown>): Operation<unknown> {
    this.calls.push(args);
    return this.result;
  }
}

/** The same tool, `protected` — the auth gate's subject. */
export class ProtectedTool extends OpenTool {
  readonly protected = true as const;
}

/** Throws `ToolRetryError` for the first `failures` calls, then returns. */
export class FlakyTool extends OpenTool {
  constructor(name: string, private readonly failures: number, private readonly retryAfterMs = 5, hooks?: ToolLifecycleHooks) {
    super(name, { ok: 'eventually' }, hooks);
  }
  override *execute(args: Record<string, unknown>): Operation<unknown> {
    this.calls.push(args);
    if (this.calls.length <= this.failures) throw new ToolRetryError('rate limited', this.retryAfterMs);
    return { ok: 'eventually' };
  }
}

/** Returns a payload far larger than the headroom the settle-reject fixtures leave. */
export class BigResultTool extends OpenTool {
  override *execute(args: Record<string, unknown>): Operation<unknown> {
    this.calls.push(args);
    return { results: ['x'.repeat(8000)] };
  }
}

export type Call = { name: string; arguments: string };
type Parser = (raw: string, format: ChatFormat, opts?: ParseChatOutputOptions) => ParseChatOutputResult;
const NOTHING: ParseChatOutputResult = { content: '', reasoningContent: '', toolCalls: [] };

/**
 * A parser keyed off the RAW turn text, the way the real-pool tests key theirs:
 * a turn whose text contains `t1` makes `calls.t1`, `t2` makes `calls.t2`, and
 * any other turn finishes with the content `done`. Scripts must use tokens
 * below 10 so `t1` cannot match inside `t12`.
 */
export function callsOn(calls: Record<string, Call>): Parser {
  return (raw, _format, opts) => {
    if (opts?.isPartial) return NOTHING;
    for (const [tok, call] of Object.entries(calls)) {
      if (raw.includes(tok)) return { content: '', reasoningContent: '', toolCalls: [{ ...call, id: `c-${tok}` }] };
    }
    return { content: 'done', reasoningContent: '', toolCalls: [] };
  };
}
/** Install `callsOn(calls)` on the run's context (`PoolSpec.instrument`). */
export const parse = (calls: Record<string, Call>) => (ctx: InstrumentedMockSessionContext) => { ctx.parseChatOutput = callsOn(calls); };

/** A policy that dispatches every call and idles otherwise — no opinions of its own. */
export const literalPolicy = (overrides: Partial<AgentPolicy> = {}): AgentPolicy => ({
  onProduced: (_a, parsed) =>
    parsed.toolCalls.length > 0
      ? { type: 'tool_call', tc: parsed.toolCalls[0] }
      : parsed.content ? { type: 'free_text_return', content: parsed.content } : { type: 'idle', reason: 'free_text_stop' },
  shouldExit: () => false,
  onRecovery: () => ({ type: 'skip' }),
  ...overrides,
});

/** One agent calls at its first turn... */
export const FIRST = [1, STOP, STOP];
/** ...and a sibling generates for a while and calls later, so the first agent's result is booked before the sibling's call is judged. */
export const LATER = [7, 7, 7, 7, 7, 7, 7, 7, 2, STOP, STOP];

// ── What the assertions read ────────────────────────────────────

export const nudges = (r: PoolRun) =>
  r.traceEvents.filter((e) => e.type === 'pool:agentNudge') as Array<{ agentId: number; guard?: string; message?: string; tool?: string }>;
export const dispatches = (r: PoolRun, tool?: string) =>
  r.traceEvents.filter((e) => e.type === 'tool:dispatch' && (tool === undefined || (e as { tool: string }).tool === tool)) as Array<{ agentId: number; callId: string; tool: string }>;
export const authRejects = (r: PoolRun) =>
  r.traceEvents.filter((e) => e.type === 'tool:authReject') as Array<{ attemptedTool: string }>;
export const outcomesOf = (r: PoolRun, i: number, tool: string) =>
  r.result.agents[i].agent.toolHistory.filter((h) => h.name === tool).map((h) => h.outcome);
export const toolResults = (events: AgentEvent[], tool: string) =>
  events.filter((e) => e.type === 'agent:tool_result' && (e as { tool: string }).tool === tool) as Array<{ result: string }>;
/** Every `branch:prefill` role, in order. */
export const prefillRoles = (r: PoolRun) =>
  r.traceEvents.filter((e) => e.type === 'branch:prefill').map((e) => (e as { role: string }).role);
/** Every settle-order entry, in order: what the pool announced it booked. */
export const settled = (r: PoolRun) =>
  (r.traceEvents.filter((e) => e.type === 'tool:settle_order') as Array<{ batch: Array<{ agentId: number; callId: string; cells: number; kind: string }> }>)
    .flatMap((o) => o.batch);
