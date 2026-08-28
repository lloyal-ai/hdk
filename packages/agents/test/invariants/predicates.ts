import type { AgentExitReason } from '../../src/types';
import type { PoolRun, NativeCall } from './harness';
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
 * Implemented as: the first store.prefill of a run carries branchCount
 * equal to the number of agentFork branch:create events preceding it.
 */
export function I4_spawnBatched(run: PoolRun): PredicateResult {
  const forks = run.traceEvents.filter(
    e => e.type === 'branch:create' && (e as any).role === 'agentFork',
  ).length;
  if (forks === 0) return ok();
  const firstPrefill = run.nativeCalls.find(c => c.op === 'prefill');
  if (!firstPrefill) {
    return fail('I4', `${forks} agentFork(s) but no store.prefill call recorded`);
  }
  if (firstPrefill.branchCount !== forks) {
    return fail(
      'I4',
      `SPAWN-phase prefill carried ${firstPrefill.branchCount} branches, expected ${forks} (batched as one native call)`,
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
 * I25 Stall-break-last-resort: settle_stall_break fires only when policy
 * said nudge and the nudge itself re-deferred (or policy is absent). A drop
 * with reason `settle_stall_break` must NOT occur when there exists an
 * active agent at the time the decision was made.
 *
 * Weakly verified via: no two drops with reason 'settle_stall_break' can
 * happen while another agent is still active in the trace.
 *
 * Strongly verified by inspecting production code paths — future work.
 * For now, check that `settle_stall_break` is used at all (not collapsed
 * with `pressure_settle_reject`).
 */
export function I25_stallBreakDistinct(run: PoolRun): PredicateResult {
  const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop');
  const reasons = new Set(drops.map(d => (d as any).reason));
  const hasSettleReject = reasons.has('pressure_settle_reject');
  const hasStallBreak = reasons.has('settle_stall_break');
  const hasStallBreakReason = drops.some(
    d => (d as any).reason === 'settle_stall_break',
  );
  if (hasSettleReject && !hasStallBreak) {
    return fail(
      'I25',
      `pressure_settle_reject present but settle_stall_break never — reasons are collapsed into one`,
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
  reason?: 'settle_reject' | 'nudge' | 'pressure_softcut' | 'pressure_settle_reject' | 'time_nudge',
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
]);

export function I30_exitReasonMatchesTrace(run: PoolRun): PredicateResult {
  const dropped = new Map<number, string>();
  for (const e of run.traceEvents) {
    if (e.type !== 'pool:agentDrop') continue;
    const reason = (e as any).reason as string;
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

/**
 * I31 Trace-tee mirror-completeness: with a real TraceWriter active, every
 * POOL-side write of a mirrored type reaches the bus exactly once as an
 * `agent:trace` envelope wrapping the SAME event (matched by traceId), with
 * the envelope's agentId agreeing with the event's own attribution. The
 * live consumer (the dev pane) must be able to trust that what it sees is
 * what the file recorded — no dropped mirrors, no duplicates, no
 * mis-attribution.
 */
const MIRRORED_TYPES = new Set<string>([
  'pool:agentNudge', 'tool:authReject', 'pool:agentDrop', 'branch:prune', 'tool:dispatch',
]);

export function I31_traceTeeMirrors(run: PoolRun): PredicateResult {
  const mirrors = new Map<number, { agentId?: number; event: TraceEvent }>();
  for (const ev of run.channelEvents) {
    if (ev.type !== 'agent:trace' || !ev.event) continue;
    if (mirrors.has(ev.event.traceId)) {
      return fail('I31', `trace event ${ev.event.traceId} (${ev.event.type}) mirrored more than once`);
    }
    mirrors.set(ev.event.traceId, { agentId: ev.agentId, event: ev.event });
  }
  for (const te of run.traceEvents) {
    if (!MIRRORED_TYPES.has(te.type)) continue;
    const m = mirrors.get(te.traceId);
    if (!m) {
      return fail('I31', `pool wrote ${te.type} (traceId ${te.traceId}) but no agent:trace mirror reached the bus`);
    }
    const owner = (te as any).agentId ?? (te as any).branchHandle;
    if (typeof owner === 'number' && m.agentId !== owner) {
      return fail(
        'I31',
        `${te.type} (traceId ${te.traceId}) belongs to agent ${owner} but its mirror is stamped agentId=${m.agentId}`,
      );
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
