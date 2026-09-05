import type { SessionContext } from '@lloyal-labs/sdk';
import { buildToolResultDelta } from '@lloyal-labs/sdk';
import type { Agent } from './Agent';
import type { AgentPolicy, PolicyConfig } from './AgentPolicy';
import { RECOVERY_PREFILL_OVERHEAD, BATCH_BUFFER } from './AgentPolicy';
import type { Tool } from './Tool';
import { type ContextPressure } from './pressure';
import {
  type TickState, type Schedule, type Pending, type PrefillItem, type RecoveryPlan,
  type StallOutcome, type Drop, emptyPending, itemCells, alive,
} from './state';

/**
 * The cohort decisions, as one pure function.
 *
 * The per-agent policy ({@link AgentPolicy}) answers questions about ONE
 * agent given a pressure value and never sees the cohort. Everything the
 * pool decides about the cohort — admission, kill ordering, recovery
 * concurrency, spawn gating, the stall-break — is here, reading a
 * {@link TickState} and returning a {@link Schedule}. Nothing here touches
 * the store or the wire; the one tokenizer call (a nudge's size) is
 * deterministic.
 */

/** Adaptive per-report budget bounds for cohort recovery when no explicit
 *  `reportBudget` is set: a fair share of headroom across the live agents,
 *  clamped to [MIN, MAX]. */
export const MIN_REPORT_BUDGET = 128;
export const MAX_REPORT_BUDGET = 2048;

export interface SchedulerOptions {
  /**
   * How reaped agents recover. `serial` (the high-effort path): one at a
   * time, ungated, uncapped — each report owns the freed headroom.
   * `cohort`: every reap's recovery turn is admitted against the recovery
   * reserve and decodes bin-packed with live siblings under a per-report
   * budget. Wind-down forces `cohort`.
   */
  recovery: 'serial' | 'cohort';
  /** Explicit per-report cap for cohort recovery and the voluntary report
   *  guillotine; absent = adaptive. */
  reportBudget?: number;
  terminalToolName?: string;
  config: PolicyConfig;
}

export interface Scheduler {
  schedule(state: TickState, policy: AgentPolicy): Schedule;
}

/** Is the agent already emitting the terminal (report) tool? Then it is
 *  producing its OWN report — it must never get a recovery turn bolted on. */
export function emittingTerminal(a: Agent, terminalToolName: string | undefined): boolean {
  return terminalToolName != null && a.currentTool === terminalToolName;
}

/**
 * How a dropped agent recovers — the ONE place the per-report budget `b` is
 * sized, shared by every drop site (schedule-time and produce-time alike).
 *
 * Cohort: `aliveCount·(OVERHEAD + b) ≤ (remaining − hardLimit) − BATCH_BUFFER`,
 * so the whole cohort's prefill+decode fits the recovery reserve in one tick;
 * an explicit `reportBudget` is clamped DOWN to that ceiling. Serial: the
 * policy derives its own full-headroom advisory and nothing caps the report.
 */
export function planRecovery(
  a: Agent, policy: AgentPolicy, pressure: ContextPressure, aliveCount: number,
  mode: 'serial' | 'cohort', reportBudget: number | undefined,
): RecoveryPlan {
  let budget: number;
  let action;
  if (mode === 'cohort') {
    const fits = Math.floor((pressure.remaining - pressure.hardLimit - BATCH_BUFFER) / Math.max(1, aliveCount)) - RECOVERY_PREFILL_OVERHEAD;
    budget = reportBudget != null
      ? (fits > 0 ? Math.min(reportBudget, fits) : reportBudget)
      : Math.min(MAX_REPORT_BUDGET, Math.max(MIN_REPORT_BUDGET, fits));
    action = policy.onRecovery?.(a, pressure, budget);
  } else {
    budget = Infinity;
    action = policy.onRecovery?.(a, pressure);
  }
  if (!action || action.type === 'skip') return { type: 'skip' };
  return { type: 'extract', action, budget, serial: mode === 'serial' };
}

export class DefaultScheduler implements Scheduler {
  constructor(
    private readonly opts: SchedulerOptions,
    private readonly ctx: SessionContext,
    private readonly tools: Map<string, Tool>,
  ) {}

  schedule(state: TickState, policy: AgentPolicy): Schedule {
    const { pressure: P0, pending, signals } = state;
    const remaining: Pending = emptyPending();
    const S: Schedule = {
      hold: false, halts: [], drops: [], finishes: [],
      spawns: [], rejectedSpawns: [], extends: [], heals: [],
      prefills: [], stall: [], abandoned: [], sweep: null, dispatch: [], decode: [],
      pressure: P0, alive: 0, remaining, mode: this.opts.recovery, roster: state.agents, close: false,
    };

    // 0. Cancels — always, paused or not. Reclamation needs no decode.
    for (const id of signals.cancelled) {
      const a = state.agents.find(x => x.id === id);
      if (!a || !alive(a)) continue;
      if (state.inflight.has(id)) S.halts.push(a);
      S.drops.push({ agent: a, reason: 'user_cancel', done: false, recovery: { type: 'none' } });
    }
    if (signals.paused) {
      // A hold keeps everything waiting exactly where it is.
      S.hold = true;
      S.remaining = pending;
      return S;
    }

    policy.resetTick?.();
    const mode: 'serial' | 'cohort' = signals.windDown ? 'cohort' : this.opts.recovery;
    S.mode = mode;
    const terminal = this.opts.terminalToolName;

    // 1. Admission — one FIFO ledger for spawns and items.
    let headroom = P0.headroom;
    const band = P0.softLimit - P0.hardLimit;
    let spent = 0;
    for (const req of pending.spawns) {
      if (req.discarded) { S.rejectedSpawns.push(req); continue; }
      if (req.suffixTokens.length <= headroom) {
        S.spawns.push(req); headroom -= req.suffixTokens.length; spent += req.suffixTokens.length;
      } else {
        S.rejectedSpawns.push(req);
      }
    }
    for (const e of pending.extends) {
      if (e.discarded) continue;
      S.extends.push(e); spent += e.tokens.length;
    }
    S.heals.push(...pending.heals);

    // A serial report already DECODING (active) blocks the next; one that is
    // merely awaiting its turn is the candidate this pass admits.
    let serialInFlight = state.agents.some(a => a.extracting && a.recoverySerial && a.status === 'active');
    const deferred: PrefillItem[] = [];
    for (const it of pending.items) {
      const a = it.agent;
      if (a.status === 'idle' || a.status === 'disposed') continue;   // the agent is gone; so is its item
      const cells = itemCells(it);
      if (it.kind === 'recovery' && a.recoverySerial) {
        // Serial recovery is ungated (the report owns the freed headroom) and
        // one at a time (the next waits for this one's prune).
        if (serialInFlight) { remaining.items.push(it); continue; }
        S.prefills.push(it); spent += cells; serialInFlight = true;
        continue;
      }
      // A recovery item reserves the REPORT room too (prompt + b) and may spend
      // the softLimit reserve down to hardLimit — the documented recovery band.
      // A plain result reserves only its own cells and stays above softLimit.
      const cost = a.extracting ? cells + a.recoveryBudget : cells;
      const budget = a.extracting ? headroom + band : headroom;
      if (cost > budget) { deferred.push(it); continue; }
      S.prefills.push(it); headroom -= cost; spent += cells;
    }
    // The post-admission value every produce-phase decision reads.
    const Pd = P0.minus(spent);
    S.pressure = Pd;

    // 2. Produce-phase verdicts, in agents order (the policy's per-tick
    //    stagger relies on that order).
    S.alive = state.agents.filter(alive).length + S.spawns.length + S.heals.length;
    const cap = Math.min(this.opts.reportBudget ?? MAX_REPORT_BUDGET, MAX_REPORT_BUDGET);
    for (const a of state.agents) {
      if (a.status !== 'active') continue;
      if (S.drops.some(d => d.agent === a)) continue;   // cancelled above
      if (signals.windDown && !a.extracting && !emittingTerminal(a, terminal)) {
        S.drops.push({ agent: a, reason: 'wind_down', done: true, recovery: this.plan(a, policy, P0, S.alive, mode) });
        continue;
      }
      const exit = policy.shouldExit?.(a, Pd);
      // `??`: a policy returning `false` vetoes; abstaining defers to pressure.
      if (!a.extracting && (exit ?? Pd.critical)) {
        const reason = Pd.critical ? 'pressure_critical' as const : 'policy_exit' as const;
        S.drops.push({
          agent: a, reason, done: true, exitReason: reason,
          recovery: emittingTerminal(a, terminal) ? { type: 'salvage' } : this.plan(a, policy, P0, S.alive, mode),
        });
        continue;
      }
      if (a.extracting && a.recoveryTokens >= a.recoveryBudget) { S.finishes.push(a); continue; }
      if (!a.extracting && emittingTerminal(a, terminal) && a.turnTokens >= cap) {
        S.drops.push({ agent: a, reason: 'report_cap', done: true, exitReason: 'report_cap', recovery: { type: 'salvage' } });
        continue;
      }
      S.decode.push(a);
    }

    // 3. Retries: due ones re-dispatch; wind-down abandons the rest.
    const wall = performance.now();
    for (const r of pending.retries) {
      if (r.agent.status !== 'awaiting_tool') continue;   // cancelled while parked
      if (signals.windDown) { S.abandoned.push(r); continue; }
      if (r.notBefore <= wall) S.dispatch.push({ agent: r.agent, tc: r.tc, retryAttempt: r.attempt, retryCallId: r.callId });
      else remaining.retries.push(r);
    }
    S.dispatch.push(...pending.dispatches);

    // 4. Stall-break: deferred items with no sibling left to free KV.
    const reactivating = S.prefills.length > 0 || S.spawns.length > 0 || S.heals.length > 0;
    if (deferred.length > 0 && S.decode.length === 0 && !reactivating) {
      let stallHeadroom = P0.headroom;
      for (const it of deferred) {
        const a = it.agent;
        if (a.status !== 'awaiting_tool' || a.branch.disposed) continue;
        // rc-deferred items ride through: their retry is a re-dispatch with
        // its own budget (MAX_DEFER_ATTEMPTS), not a headroom problem.
        if (a.deferAttempts > 0) { remaining.items.push(it); continue; }
        const action = policy.onSettleReject?.(a, itemCells(it), P0, this.opts.config);
        const reason = action ? 'pressure_settle_reject' as const : 'settle_stall_break' as const;
        if (it.kind === 'recovery') {
          // An extracting agent whose cohort turn never fit: its span already
          // ended at the kill, so no second `agent:done`; the turn is re-planned
          // serial so the report decodes from the reserve, one at a time.
          S.stall.push({ agent: a, nudge: null, drop: { agent: a, reason, done: false, recovery: this.plan(a, policy, P0, S.alive, 'serial') } });
          continue;
        }
        let nudge: StallOutcome['nudge'] = null;
        if (action?.type === 'nudge') {
          const nudgeResult = { error: action.message };
          const tokens = buildToolResultDelta(this.ctx, JSON.stringify(nudgeResult), it.callId, { enableThinking: a.fmt.enableThinking });
          const fits = tokens.length <= stallHeadroom;
          const replacement: PrefillItem | null = fits ? {
            kind: 'nudge', rail: 'token', agent: a, tokens,
            toolName: it.toolName, callId: it.callId, args: it.args,
            probe: this.tools.get(it.toolName)?.probe(nudgeResult) ?? undefined,
          } : null;
          nudge = { message: action.message, tool: it.toolName, args: it.args, replacement };
          if (replacement) { remaining.items.push(replacement); stallHeadroom -= tokens.length; }
        }
        // The policy's suggestion was infeasible (or it said idle, or it is absent): drop.
        const drop: Drop | null = nudge?.replacement ? null
          : { agent: a, reason, done: true, recovery: this.plan(a, policy, P0, S.alive, mode) };
        S.stall.push({ agent: a, nudge, drop });
      }
    } else {
      remaining.items.push(...deferred);
    }

    // 5. Close, or the close-time sweep: one serial recovery per tick for an
    //    agent that idled without a result and was never discarded.
    const allIdle = state.agents.every(a => a.status === 'idle' || a.status === 'disposed');
    const nothingWaiting =
      remaining.items.length === 0 && remaining.retries.length === 0 &&
      S.prefills.length === 0 && S.spawns.length === 0 && S.extends.length === 0 &&
      S.heals.length === 0 && S.dispatch.length === 0 && S.decode.length === 0 &&
      S.drops.length === 0 && S.stall.length === 0 && S.finishes.length === 0 && S.abandoned.length === 0 &&
      state.inflight.size === 0;
    if (signals.orchestratorDone && allIdle && nothingWaiting) {
      const c = state.agents.find(a =>
        a.status === 'idle' && !a.result && !a.branch.disposed && a.failed === null && !a.extracting);
      if (c) {
        S.sweep = { agent: c, recovery: this.plan(c, policy, P0, 1, 'serial') };
      } else {
        // The prune pass runs before every schedule; anything still owed a
        // prune is a branch with live children, which the close cannot free.
        S.close = true;
      }
    }
    return S;
  }

  private plan(a: Agent, policy: AgentPolicy, P0: ContextPressure, aliveCount: number, mode: 'serial' | 'cohort'): RecoveryPlan {
    return planRecovery(a, policy, P0, aliveCount, mode, this.opts.reportBudget);
  }
}

