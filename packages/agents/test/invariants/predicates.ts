import type { AgentExitReason } from '../../src/types';
import type { PoolRun, NativeCall } from './harness';
import type { AgentEvent } from '../../src/types';
import type { TraceEvent } from '../../src/trace-types';

export interface Violation {
  invariant: string;
  detail: string;
  at?: number;
}

export interface PredicateResult {
  ok: boolean;
  violations: Violation[];
}

function ok(): PredicateResult { return { ok: true, violations: [] }; }
function fail(invariant: string, detail: string, at?: number): PredicateResult {
  return { ok: false, violations: [{ invariant, detail, at }] };
}

/** I1 Native-store-single-fiber: no two native calls overlap in time. */
export function I1_nativeStoreSingleFiber(run: PoolRun): PredicateResult {
  const calls = run.nativeCalls.slice().sort((a, b) => a.tStart - b.tStart);
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const cur = calls[i];
    if (cur.tStart < prev.tEnd) {
      return fail(
        'I1',
        `native ${prev.op} (seq ${prev.seq}, ended ${prev.tEnd.toFixed(3)}ms) overlaps with ${cur.op} (seq ${cur.seq}, started ${cur.tStart.toFixed(3)}ms)`,
      );
    }
  }
  return ok();
}

/**
 * I4 SPAWN-batched: when multiple agents spawn "at once" (same tick), their
 * suffix prefill lands in one native prefill call with N pairs, not N calls.
 * Implemented as: the spawn batch is the LAST store.prefill that started
 * before the first agentFork `branch:create` — the create is written once the
 * suffix has landed, so the batch precedes it and the root's own prefill is
 * earlier still. It must carry branchCount equal to the number of agentFork
 * creates.
 */
export function I4_spawnBatched(run: PoolRun): PredicateResult {
  const forks = run.traceEvents.filter(
    e => e.type === 'branch:create' && (e as any).role === 'agentFork',
  ).length;
  if (forks === 0) return ok();
  const firstFork = run.traceEvents.find(
    e => e.type === 'branch:create' && (e as any).role === 'agentFork',
  ) as { ts: number };
  const before = run.nativeCalls.filter(c => c.op === 'prefill' && c.tStart < firstFork.ts);
  const spawnBatch = before[before.length - 1];
  if (!spawnBatch) {
    return fail('I4', `${forks} agentFork(s) but no store.prefill call recorded before the first fork create`);
  }
  if (spawnBatch.branchCount !== forks) {
    return fail(
      'I4',
      `SPAWN-phase prefill carried ${spawnBatch.branchCount} branches, expected ${forks} (batched as one native call)`,
    );
  }
  return ok();
}

/**
 * I24 SETTLE-policy-consulted: when SETTLE encounters an oversized tool
 * result (headroom exceeded) the policy's onSettleReject is consulted.
 *
 * Proxy assertion: for every agent drop with reason `pressure_settle_reject`
 * or `settle_stall_break`, the run must have called the policy's
 * onSettleReject at least once for that agent (counted by the policy probe).
 *
 * Since we don't have direct visibility into policy calls from trace events,
 * this predicate requires the caller to pass a probe — see I24_via_probe.
 */
export function I24_settlePolicyConsulted(
  run: PoolRun,
  probeCallCount: number,
): PredicateResult {
  const settleDrops = run.traceEvents.filter(
    e => e.type === 'pool:agentDrop'
      && ((e as any).reason === 'pressure_settle_reject'
        || (e as any).reason === 'settle_stall_break'),
  );
  if (settleDrops.length === 0) return ok();
  if (probeCallCount === 0) {
    return fail(
      'I24',
      `${settleDrops.length} settle-related drop(s) but policy.onSettleReject was never invoked`,
    );
  }
  return ok();
}

/**
 * I29 Recovery-diagnostic-complete: every recovery attempt emits exactly
 * one of pool:recoveryReturn / pool:recoveryFailed after its
 * branch:prefill role=recovery.
 */
export function I29_recoveryDiagnostic(run: PoolRun): PredicateResult {
  const recoveryPrefills = run.traceEvents.filter(
    e => e.type === 'branch:prefill' && (e as any).role === 'recovery',
  );
  if (recoveryPrefills.length === 0) return ok();
  for (const prefill of recoveryPrefills) {
    const agentId = (prefill as any).branchHandle;
    const rest = run.traceEvents.slice(run.traceEvents.indexOf(prefill) + 1);
    const report = rest.find(
      e => (e.type === 'pool:recoveryReturn' || e.type === 'pool:recoveryFailed')
        && (e as any).agentId === agentId,
    );
    if (!report) {
      return fail(
        'I29',
        `recovery prefill for agent ${agentId} emitted no pool:recoveryReturn or pool:recoveryFailed diagnostic`,
      );
    }
  }
  return ok();
}

/**
 * Helper: every `pool:agentNudge` event with `reason` carries a numeric
 * budget in its message ("… within N words"). Use after any scenario
 * that nudges, to verify the budget-surfacing invariant.
 */
export function nudgeMessageContainsBudget(
  run: PoolRun,
  reason?: 'settle_reject' | 'nudge' | 'pressure_softcut' | 'pressure_settle_reject',
): PredicateResult {
  const nudges = run.traceEvents.filter(e => e.type === 'pool:agentNudge');
  const filtered = reason
    ? nudges.filter(n => (n as any).reason === reason)
    : nudges;
  if (filtered.length === 0) return ok();
  for (const n of filtered) {
    const msg = (n as any).message as string | undefined;
    if (!msg || !/within \d+ words/.test(msg)) {
      return fail(
        'budget-visible',
        `nudge (reason=${(n as any).reason}) has no "within N words" budget: ${msg ?? '<missing>'}`,
      );
    }
  }
  return ok();
}

/**
 * I30: the trace and the returned value agree about why an agent stopped.
 *
 * The pool has always computed a drop reason and written it to the trace as
 * `pool:agentDrop.reason`, but `AgentResult` carried only `result` — so a
 * caller holding a report could not tell a considered one from a forced
 * recovery written to a capped budget under `pressure_critical`. Every
 * downstream consumer, a `dag` dependent above all, treated the two alike.
 *
 * `exitReason` now rides the result. This asserts the two halves agree in
 * BOTH directions, which is the only form that catches drift: a drop with no
 * recorded reason, and a recorded reason with no drop.
 *
 * Scoped to the reasons the agent records. The pool emits other drop reasons
 * (`pressure_settle_reject`, `settle_stall_break`) that are deliberately NOT
 * carried on the agent — they describe a turn being rejected rather than the
 * agent stopping, and folding them in would make `exitReason` mean two things.
 */
const RECORDED_EXIT_REASONS = new Set<AgentExitReason>([
  'pressure_critical',
  'policy_exit',
  'pressure_softcut',
  'maxTurns',
  'terminal_cap',
]);

export function I30_exitReasonMatchesTrace(run: PoolRun): PredicateResult {
  const dropped = new Map<number, string>();
  for (const e of run.traceEvents) {
    if (e.type !== 'pool:agentDrop') continue;
    const reason = (e as { reason: AgentExitReason }).reason;
    if (!RECORDED_EXIT_REASONS.has(reason)) continue;
    dropped.set((e as any).agentId, reason);
  }

  for (const agent of run.result.agents) {
    const traced = dropped.get(agent.agentId);
    if (traced && agent.exitReason !== traced) {
      return fail(
        'I30',
        `agent ${agent.agentId} was dropped with reason='${traced}' but its AgentResult ` +
          `carries exitReason=${JSON.stringify(agent.exitReason)} — a caller cannot tell ` +
          `this result was produced under duress`,
      );
    }
    if (!traced && agent.exitReason !== undefined) {
      return fail(
        'I30',
        `agent ${agent.agentId} carries exitReason='${agent.exitReason}' but no ` +
          `pool:agentDrop was traced for it — the value is unattributable`,
      );
    }
  }
  return ok();
}

/** Trace types that are ABOUT one agent's work — each must carry its owner
 *  in the record itself (`agentId`, or `branchHandle` for branch events).
 *  The writer-boundary mirror (rig's `useTraceWriter`) attributes envelopes
 *  from exactly these fields; an unowned write here would reach the pane
 *  as agentId -1. */
const ATTRIBUTED_TYPES = new Set<TraceEvent['type']>([
  'pool:agentNudge', 'tool:authReject', 'pool:agentDrop', 'branch:prune',
  'tool:dispatch',
]);

/**
 * I31 — trace attribution completeness. Attribution lives in the DATA:
 * every agent-owned trace write carries its owner on the record itself, so
 * the writer-boundary mirror (rig's `useTraceWriter`, tested in rig) can
 * attribute what it carries — and the POOL bus carries no `agent:trace`
 * envelopes at all: the pool stamps, it does not mirror.
 */
export function I31_traceAttribution(run: PoolRun): PredicateResult {
  for (const ev of run.channelEvents) {
    if (ev.type === 'agent:trace') {
      return fail('I31', 'the pool bus carried an agent:trace envelope — the mirror lives at the writer boundary, not in the pool');
    }
  }
  for (const te of run.traceEvents) {
    if (!ATTRIBUTED_TYPES.has(te.type)) continue;
    const owner = (te as any).agentId ?? (te as any).branchHandle;
    if (typeof owner !== 'number') {
      return fail('I31', `${te.type} (traceId ${te.traceId}) carries no attribution — a live mirror could not attribute it`);
    }
  }
  return ok();
}

/**
 * Format a PredicateResult for fast-check / expect output.
 */
export function formatResult(name: string, r: PredicateResult): string {
  if (r.ok) return `${name}: ok`;
  return `${name}: ${r.violations.map(v => `[${v.invariant}] ${v.detail}`).join('; ')}`;
}

/**
 * I32 — pause means paused: between each `pool:pause` and its `pool:resume`
 * trace marker, NO native call starts. The branches sit resident; the loop
 * holds; nothing decodes, prefills, commits, or samples. The one invariant
 * that makes "pause" an honest word.
 */
export function I32_pauseHoldsNative(run: PoolRun): PredicateResult {
  const spans: Array<{ from: number; to: number }> = [];
  let openAt: number | null = null;
  for (const te of run.traceEvents) {
    if (te.type === 'pool:pause') openAt = te.ts;
    if (te.type === 'pool:resume' && openAt !== null) {
      spans.push({ from: openAt, to: te.ts });
      openAt = null;
    }
  }
  if (openAt !== null) return fail('I32', 'pool:pause with no matching pool:resume');
  if (spans.length === 0) return fail('I32', 'no pause span found — the driver never paused');
  for (const span of spans) {
    for (const c of run.nativeCalls) {
      if (c.tStart > span.from && c.tStart < span.to) {
        return fail(
          'I32',
          `native ${c.op} (seq ${c.seq}) started at ${c.tStart.toFixed(1)} inside the pause span ` +
          `[${span.from.toFixed(1)}, ${span.to.toFixed(1)}]`,
          c.tStart,
        );
      }
    }
  }
  return ok();
}

/** The agent an event is about, on either stream. Branch events carry the
 *  handle instead, and for an agent fork the handle IS the agent id. */
function idOf(e: AgentEvent | TraceEvent): number | undefined {
  const r = e as { agentId?: number; branchHandle?: number };
  return r.agentId ?? r.branchHandle;
}
/** Channel events that end an agent's span. */
const TERMINAL = new Set(['agent:return', 'agent:recovered', 'agent:failed', 'agent:done']);

/**
 * I33 Agent-failure-is-isolated — a SCENARIO predicate, not a global invariant.
 *
 * It cannot be global. A legitimate run may have one agent; every agent may
 * fail independently; a sibling may have finished BEFORE the failure. "Some
 * other agent reached a terminal event" is false in all three and says nothing
 * about isolation.
 *
 * What isolation actually means is causal: an agent that was still LIVE at the
 * moment another failed must go on to reach a terminal event of its own, and
 * the pool must close normally. That distinguishes "one agent pruned, siblings
 * survived" from "the failure took the run down with it" — which is exactly
 * the shape the pool's outer catch produces, since it closes with a partial
 * result and no error at all.
 *
 * @param run   the pool run
 * @param reason optional `agent:failed` reason to scope to (e.g.
 *               `'media_prefill_failed'`); omit to check every failure.
 */
export function I33_agentFailureIsIsolated(
  run: PoolRun,
  reason?: string,
): PredicateResult {
  const evs = run.channelEvents;

  // FIRST, and unconditionally: a torn-down run emits NO `agent:failed` at all,
  // so keying the whole check off failures makes it vacuous exactly when the
  // bug is present. Measured: a refused ingress yields spawn×2, one tool_call,
  // zero failures, and no `pool:close` — the tick loop's outer catch closes the
  // channel with a partial result and swallows the reason.
  if (!run.traceEvents.some(e => e.type === 'pool:close')) {
    return fail('I33', 'pool never emitted pool:close — the run was torn down, not completed');
  }

  const failures = evs
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === 'agent:failed'
      && (reason === undefined || (e as { reason?: string }).reason === reason));
  if (failures.length === 0) return ok();

  for (const { e: failure, i: at } of failures) {
    const deadId = idOf(failure);
    // Live at the instant of the failure: spawned before it, and no terminal
    // event of its own before it. Ordering is the whole point — a sibling that
    // had already finished proves nothing about isolation.
    const live = new Set<number>();
    for (let j = 0; j < at; j++) {
      const id = idOf(evs[j]);
      if (id === undefined || id === deadId) continue;
      if (evs[j].type === 'agent:spawn') live.add(id);
      if (TERMINAL.has(evs[j].type)) live.delete(id);
    }
    for (const id of live) {
      const survived = evs.slice(at + 1).some(e => idOf(e) === id && TERMINAL.has(e.type));
      if (!survived) {
        return fail(
          'I33',
          `agent ${id} was live when agent ${deadId} failed` +
            `${reason ? ` (${reason})` : ''} and never reached a terminal event — ` +
            'the failure took its sibling down with it',
        );
      }
    }
  }

  return ok();
}

/**
 * I41 terminal-is-last: once the pool has announced an agent FAILED, it does
 * no further work for that agent — no admission, no dispatch, no sampling.
 *
 * `agent:failed` is the one terminal event with nothing legitimately after it
 * (`agent:done` precedes a recovery stream by design, so it is not checked).
 * Both streams are read: the channel for what a consumer saw, the trace for
 * what the pool actually did to the KV. A `tool:settle_order` batch counts
 * through its entries, since the event itself carries no agentId.
 */
export function I41_terminalIsLast(run: PoolRun): PredicateResult {
  const LATER_CHANNEL = new Set(['agent:tool_call', 'agent:produce', 'agent:tool_result', 'agent:spawn']);
  const LATER_TRACE = new Set(['branch:prefill', 'tool:dispatch', 'agent:turn']);

  const failedAt = new Map<number, number>();
  run.channelEvents.forEach((e, i) => {
    const id = idOf(e);
    if (e.type === 'agent:failed' && id !== undefined && !failedAt.has(id)) failedAt.set(id, i);
  });
  for (const [id, at] of failedAt) {
    const later = run.channelEvents.slice(at + 1).find(e => idOf(e) === id && LATER_CHANNEL.has(e.type));
    if (later) {
      return fail('I41', `agent ${id}: \`${later.type}\` on the channel after its agent:failed`, at);
    }
  }

  // The trace has no `agent:failed`; its mirrors are the user_cancel drop and
  // the settle failure, the two records whose bus twin is `agent:failed`.
  const failedTs = new Map<number, number>();
  for (const e of run.traceEvents) {
    const id = idOf(e);
    const mirrors = e.type === 'pool:settleFailed'
      || (e.type === 'pool:agentDrop' && (e as { reason?: string }).reason === 'user_cancel');
    if (mirrors && id !== undefined && !failedTs.has(id)) failedTs.set(id, e.ts);
  }
  for (const e of run.traceEvents) {
    if (e.type === 'tool:settle_order') {
      for (const entry of (e as { batch: { agentId: number }[] }).batch) {
        const t0 = failedTs.get(entry.agentId);
        if (t0 !== undefined && e.ts > t0) {
          return fail('I41', `agent ${entry.agentId}: admitted (tool:settle_order) after its agent:failed`);
        }
      }
      continue;
    }
    const id = idOf(e);
    if (id === undefined || !LATER_TRACE.has(e.type)) continue;
    const t0 = failedTs.get(id);
    if (t0 !== undefined && e.ts > t0) {
      return fail('I41', `agent ${id}: \`${e.type}\` in the trace after its agent:failed`);
    }
  }
  return ok();
}

/**
 * I42 no-leaked-branches: at pool end the only live branch is the root the
 * pool was given, whichever path ended the pool.
 *
 * A fork holds a KV sequence lease (`kv::tenancy`) that only `release()`
 * returns, and leases are the scarce resource — `branches: 4` on a laptop.
 * The trace cannot see a fork that never landed (`branch:create` is written
 * after its suffix prefill), so this reads the mock's branch table directly:
 * every handle but the root must be disposed, and the cell gauge must be back
 * to the root's own position.
 */
export function I42_noLeakedBranches(run: PoolRun): PredicateResult {
  const live = run.ctx.liveHandles().filter(h => h !== run.rootHandle);
  if (live.length > 0) {
    return fail('I42', `${live.length} branch(es) still live at pool end besides the root: ${live.join(', ')}`);
  }
  const rootPosition = run.ctx.positionOf(run.rootHandle);
  if (run.ctx.cellsUsed !== rootPosition) {
    return fail('I42', `cellsUsed is ${run.ctx.cellsUsed} at pool end, the root alone holds ${rootPosition}`);
  }
  return ok();
}
