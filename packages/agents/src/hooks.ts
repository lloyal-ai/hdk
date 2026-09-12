/**
 * The frame: where the pool composes what a tool, a harness and the framework
 * each say about the life of a tool call.
 *
 * Three contributors of one type ({@link ToolLifecycleHooks}): the called
 * tool's own `hooks`, the policy's `hooks` in order, and the framework's
 * frame, itself a value of that type. One rule at every position: the first
 * concrete decision wins, `undefined` abstains. The frame's gate runs first
 * (authorization precedes every other gate); the frame's defaults run last,
 * so a call always ends with a decision.
 *
 * Two places the rule is deliberately not uniform, stated rather than hidden:
 * a harness's `guardOverrides` apply to the tool's and the policy's gates and
 * never to the frame's, so authorization cannot be switched off by name; and
 * every decision comes back with who made it ({@link Resolved}), because the
 * pool's drop reasons and its trace need to say so while no public hook type
 * should have to carry it.
 *
 * Pure functions over values. Nothing here touches the store.
 *
 * @packageDocumentation
 * @category Agents
 */
import type { ParsedToolCall } from '@lloyal-labs/sdk';
import type { Agent } from './Agent';
import { argsOf, isAttended, parseHistoryArgs } from './Agent';
import type { AgentPolicy, GuardScope } from './AgentPolicy';
import type {
  Tool,
  ToolGuard,
  GuardInput,
  ToolLifecycleHooks,
  ExecuteDecision,
  AdmitDecision,
  FollowUp,
} from './Tool';
import { ToolRetryError } from './Tool';

/** How many times a transient failure is retried when nobody says otherwise. */
export const DEFAULT_MAX_TOOL_RETRIES = 1;

/** A decision and who made it. Internal to the pool; no public hook type carries it. */
export type Resolved<T> = { decision: T; by: 'frame' | 'tool' | 'policy' };

/**
 * A retry budget as an `afterExecute` contributor: park a transient failure
 * up to `n` times at the delay the tool asked for, then fail. Abstains on any
 * other completion. The one place the framework recognizes a transient failure.
 */
export function retryUpTo(n: number): NonNullable<ToolLifecycleHooks['afterExecute']> {
  return ({ completion, attempt }) => {
    if (completion.kind !== 'threw' || !(completion.error instanceof ToolRetryError)) return undefined;
    return attempt <= n
      ? { type: 'retry', afterMs: completion.error.retryAfterMs }
      : { type: 'fail' };
  };
}

/** The inputs of the three decided positions, named once so the frame's totals share them. */
export type AfterExecuteInput = Parameters<NonNullable<ToolLifecycleHooks['afterExecute']>>[0];
export type BeforeAdmitInput = Parameters<NonNullable<ToolLifecycleHooks['beforeAdmit']>>[0];
export type AfterAdmitInput = Parameters<NonNullable<ToolLifecycleHooks['afterAdmit']>>[0];

/** Today's behaviour when no contributor decides: a transient failure is retried once, anything else is an attempt. */
export const defaultAfterExecute = (i: AfterExecuteInput): ExecuteDecision =>
  retryUpTo(DEFAULT_MAX_TOOL_RETRIES)(i) ?? { type: 'attempt' };

/** Today's behaviour when no contributor decides: a result that does not fit drops the agent. */
export const defaultBeforeAdmit = (_i: BeforeAdmitInput): AdmitDecision => ({ type: 'drop' });

/** Today's behaviour when no contributor decides: no follow-up. */
export const defaultAfterAdmit = (_i: AfterAdmitInput): FollowUp => ({ type: 'none' });

/** The frame's gate, by the name the trace and `tool:authReject` know it by. */
export const AUTH_REJECT_GUARD = 'auth_reject';

/** What the model reads when a protected tool is called without a grant. */
export const AUTH_REJECT_MESSAGE =
  'This action is protected and requires authorization that has not been ' +
  'granted for this session. Use the available read tools to gather what ' +
  'you can, and report what blocks completion.';

/** The frame: the framework's own contributor, with every default present so a walk always ends in a decision. */
export interface Frame extends ToolLifecycleHooks {
  beforeDispatch: readonly ToolGuard[];
  afterExecute: (i: AfterExecuteInput) => ExecuteDecision;
  beforeAdmit: (i: BeforeAdmitInput) => AdmitDecision;
  afterAdmit: (i: AfterAdmitInput) => FollowUp;
}

/**
 * Build the frame for one pool from the authorization facts the pool resolves
 * once: the tools declared `protected`, and the grants the session holds.
 */
export function makeFrame(auth: { protectedTools: ReadonlySet<string>; grants: ReadonlySet<string> }): Frame {
  const authGate: ToolGuard = {
    name: AUTH_REJECT_GUARD,
    reject: (i) => auth.protectedTools.has(i.tool) && !auth.grants.has(i.tool),
    message: AUTH_REJECT_MESSAGE,
  };
  return {
    beforeDispatch: [authGate],
    afterExecute: defaultAfterExecute,
    beforeAdmit: defaultBeforeAdmit,
    afterAdmit: defaultAfterAdmit,
  };
}

/** The three contributors at one call. `tool` is absent for a call the toolkit does not know. */
export interface Contributors {
  frame: Frame;
  tool: Tool | undefined;
  policy: AgentPolicy;
}

type Walked = { by: Resolved<unknown>['by']; hooks: ToolLifecycleHooks };

/** The walk for every position but the gate: the tool, then the policy's in order, then the frame. */
function afterwards(c: Contributors): Walked[] {
  const out: Walked[] = [];
  if (c.tool?.hooks) out.push({ by: 'tool', hooks: c.tool.hooks });
  for (const h of c.policy.hooks ?? []) out.push({ by: 'policy', hooks: h });
  out.push({ by: 'frame', hooks: c.frame });
  return out;
}

/**
 * May this call run. Walks the frame's gates (never overridable), then the
 * tool's, then the policy's in order, skipping a gate the harness switched
 * off and re-scoping one it re-scoped; `attended()` is computed once per
 * scope, on first use. The first refusal wins.
 */
export function decideBeforeDispatch(i: {
  tc: ParsedToolCall;
  agent: Agent;
  /** The pool's live roster — what a cohort-scoped gate reads. */
  roster: readonly Agent[];
} & Contributors): Resolved<{ message: string; guard: string }> | undefined {
  const { tc, agent, roster, frame, tool, policy } = i;
  const args = parseHistoryArgs(tc.arguments);
  const overrides = policy.guardOverrides ?? {};
  const slices: Partial<Record<GuardScope, readonly Record<string, unknown>[]>> = {};
  const attendedIn = (scope: GuardScope): readonly Record<string, unknown>[] =>
    (slices[scope] ??= argsOf(
      (scope === 'lineage' ? agent.walkAncestors((a) => a.toolHistory) : roster.flatMap((a) => a.toolHistory)).filter(isAttended),
      tc.name,
    ));

  const gates: Array<{ by: Resolved<unknown>['by']; gate: ToolGuard; overridable: boolean }> = [];
  for (const gate of frame.beforeDispatch) gates.push({ by: 'frame', gate, overridable: false });
  for (const gate of tool?.hooks?.beforeDispatch ?? []) gates.push({ by: 'tool', gate, overridable: true });
  for (const h of policy.hooks ?? []) for (const gate of h.beforeDispatch ?? []) gates.push({ by: 'policy', gate, overridable: true });

  for (const { by, gate, overridable } of gates) {
    // Own keys only: a gate named like an Object.prototype member must not read the prototype.
    const override = overridable && Object.hasOwn(overrides, gate.name) ? overrides[gate.name] : undefined;
    if (override === false) continue;
    const scope: GuardScope = override ? override.scope : 'lineage';
    const input: GuardInput = { tool: tc.name, args, attended: () => attendedIn(scope) };
    if (gate.reject(input)) return { decision: { message: gate.message, guard: gate.name }, by };
  }
  return undefined;
}

/** The call completed. Is this an attempt, or not yet. */
export function decideAfterExecute(input: AfterExecuteInput, c: Contributors): Resolved<ExecuteDecision> {
  for (const { by, hooks } of afterwards(c)) {
    const decision = hooks.afterExecute?.(input);
    if (decision) return { decision, by };
  }
  return { decision: c.frame.afterExecute(input), by: 'frame' };
}

/** The result does not fit and nothing can free room. */
export function decideBeforeAdmit(input: BeforeAdmitInput, c: Contributors): Resolved<AdmitDecision> {
  for (const { by, hooks } of afterwards(c)) {
    const decision = hooks.beforeAdmit?.(input);
    if (decision) return { decision, by };
  }
  return { decision: c.frame.beforeAdmit(input), by: 'frame' };
}

/** The result is admitted and on the agent's ledger. */
export function decideAfterAdmit(input: AfterAdmitInput, c: Contributors): Resolved<FollowUp> {
  for (const { by, hooks } of afterwards(c)) {
    const decision = hooks.afterAdmit?.(input);
    if (decision) return { decision, by };
  }
  return { decision: c.frame.afterAdmit(input), by: 'frame' };
}
