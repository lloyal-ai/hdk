import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';
import type { PoolRun } from '../harness';
import { I1_nativeStoreSingleFiber, I29_recoveryDiagnostic } from '../predicates';

const N = 3;

/**
 * Every agent drops to idle WITHOUT a result on its first stop
 * (`free_text_stop`, not `free_text_return`), so all N land in the
 * termination-sweep recovery cohort. `onRecovery` always extracts (no
 * min-token/min-tool gates), and `recoveryShape` selects the reap path under
 * test. The recovery prompt is a parameter so the pressure tests can make
 * Σ(prefill) dwarf the available headroom.
 */
function idleNoResultPolicy(
  shape: 'staggered' | 'parallel',
  recoveryPrompt: { system: string; user: string },
): AgentPolicy {
  return {
    onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
    onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    onRecovery: () => ({ type: 'extract', prompt: recoveryPrompt }),
    shouldExit: () => false,
    recoveryShape: shape,
  };
}

/**
 * A `'parallel'` policy that records the per-report budget the fold hands each
 * agent — the fold's recovery pass calls `onRecovery(agent, pressure, b)` WITH a
 * budget, while the eligibility probe calls it WITHOUT one, so recording only the
 * defined-`budgetTokens` calls captures the fold's actual per-report budgets.
 * Optionally pins a fixed `reportBudget` (the low-effort path) instead of the
 * headroom-derived default.
 */
function recordingParallelPolicy(sink: number[], reportBudget?: number): AgentPolicy {
  return {
    onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
    onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    onRecovery: (_a, _pressure, budgetTokens) => {
      if (budgetTokens !== undefined) sink.push(budgetTokens);
      return { type: 'extract', prompt: { system: 's', user: 'u' } };
    },
    shouldExit: () => false,
    recoveryShape: 'parallel',
    ...(reportBudget !== undefined ? { reportBudget } : {}),
  };
}

const recoveryPrefills = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'branch:prefill' && (e as { role?: string }).role === 'recovery');
const prefillCount = (r: PoolRun) =>
  r.nativeCalls.filter(c => c.op === 'prefill').length;

// Each agent: main turn [1, STOP], then recovery decode [2, STOP]. The mock
// emits non-JSON text from token 2 → recovery lands on `pool:recoveryFailed`
// (we assert the batching *shape* + budget, not parse success — the mock can't
// produce grammar-valid JSON, and ignores the maxLength grammar entirely).
const idleScriptsN = (n: number) =>
  Array.from({ length: n }, () => ({ tokens: [1, STOP, 2, STOP], content: 'prose findings' }));
const idleScripts = () => idleScriptsN(N);

// Group count of a parallel fold run, derived from the prefill delta vs a
// staggered baseline: staggered does one recovery prefill per agent (M), the fold
// does one per group (G), and root+spawn prefills (S) are identical between runs —
// so prefillCount(par) − prefillCount(stag) = (S+G) − (S+M) = G − M.
const groupCount = (par: PoolRun, stag: PoolRun, m: number) =>
  prefillCount(par) - prefillCount(stag) + m;

/**
 * Parallel recovery is a bounded FOLD: each step recovers the largest group of
 * the cohort that fits in current KV at a fixed per-report budget `b`, prunes it
 * (freeing KV), and recurses. `k` (group size) flexes 1..N with headroom — k=N
 * (one batched pass) when KV is ample, k=1 (one report at a time) when it's tight,
 * intermediate when moderate. The maxLength report cap itself is verified against
 * the real model (the grammar probe — `result ::= "\"" char{0,N} "\"" space`);
 * here the mock ignores the grammar, so we assert the fold's *packing* + *budget*.
 */
describe('scenario: parallel recovery (the fold)', () => {
  it('packs the whole cohort into ONE batched pass when KV is ample (k=N)', async () => {
    // Small recovery prompt + generous nCtx → all N reports fit at once, so the
    // fold takes one group = one batched prefill. Same scripts/policy except the
    // reap shape, so root + spawn prefills are identical between the two runs.
    const prompt = { system: 's', user: 'u' };
    const par = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: idleScripts(), policy: idleNoResultPolicy('parallel', prompt) });
    const stag = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: idleScripts(), policy: idleNoResultPolicy('staggered', prompt) });

    // Both shapes recover every agent (one recovery prefill trace each).
    expect(recoveryPrefills(par).length).toBe(N);
    expect(recoveryPrefills(stag).length).toBe(N);

    // THE batching proof: the only difference between the runs is the reap shape,
    // so the fold collapsing N recovery prefills into one batched `store.prefill`
    // shows up as exactly (N-1) fewer native prefill calls.
    expect(prefillCount(par)).toBe(prefillCount(stag) - (N - 1));

    // The batched decode holds the single-fiber invariant (the SEGV guard)…
    expect(I1_nativeStoreSingleFiber(par).ok).toBe(true);
    // …and every recovering agent still gets exactly one diagnostic (no loss).
    expect(I29_recoveryDiagnostic(par).ok).toBe(true);
  });

  it('shrinks to k=1 under pressure — one report at a time, none lost', async () => {
    // Huge recovery prompt → at most one (prompt + report) fits per step, so the
    // fold groups into N singletons: same native-prefill count as staggered, but
    // reached by the fold partitioning, not a binary gate. Prune-between frees KV
    // for the next singleton; every report still lands.
    const big = 'x'.repeat(4000); // ~1000 tokens each; ~3000 across the cohort
    const prompt = { system: big, user: big };
    const parPressure = await runPool({ nCtx: 4096, cellsUsed: 0, scripts: idleScripts(), policy: idleNoResultPolicy('parallel', prompt) });
    const stagPressure = await runPool({ nCtx: 4096, cellsUsed: 0, scripts: idleScripts(), policy: idleNoResultPolicy('staggered', prompt) });

    // k=1 ⇒ the fold's per-step prefills match the staggered baseline (no N→1 collapse).
    expect(prefillCount(parPressure)).toBe(prefillCount(stagPressure));

    // Every agent still recovered — the grouping loses no reports.
    expect(recoveryPrefills(parPressure).length).toBe(N);
    expect(I29_recoveryDiagnostic(parPressure).ok).toBe(true);
  });

  it('folds into intermediate groups (1 < k < N) under moderate pressure — the partition branch', async () => {
    // Headroom-derived budget: fitting all M at once is impossible (the prompts add
    // overhead beyond the M×b the budget reserves), but several fit — so the fold
    // takes a partial first group, then recovers the rest after pruning replenishes
    // KV. This exercises the `used + cost > budget` break — the packing branch that
    // k=N and k=1 never reach.
    const M = 4;
    const prompt = { system: 's', user: 'u' };
    const par = await runPool({ nCtx: 4096, cellsUsed: 0, scripts: idleScriptsN(M), policy: idleNoResultPolicy('parallel', prompt) });
    const stag = await runPool({ nCtx: 4096, cellsUsed: 0, scripts: idleScriptsN(M), policy: idleNoResultPolicy('staggered', prompt) });

    const groups = groupCount(par, stag, M);
    expect(groups).toBeGreaterThan(1);   // not one all-at-once pass…
    expect(groups).toBeLessThan(M);      // …and not M singletons either

    // Every agent still recovered — partitioning loses nothing.
    expect(recoveryPrefills(par).length).toBe(M);
    expect(I29_recoveryDiagnostic(par).ok).toBe(true);
  });

  it('budgets each report at a SHARE of KV, never the whole pool (the pool-wide-budget fix)', async () => {
    // The bug the fold fixes: the old batched recovery told every concurrent agent
    // it owned the full remaining KV → N reports collectively exhausted it. The fold
    // passes a per-report budget `b` (a fair share of headroom) via the onRecovery
    // override. Record what the fold hands each report and assert it's a share, not
    // the pool. nCtx 4096 keeps the share below the MAX_REPORT_BUDGET cap so we see
    // the division, not the clamp.
    const foldBudgets: number[] = [];
    const nCtx = 4096;
    const run = await runPool({ nCtx, cellsUsed: 0, scripts: idleScripts(), policy: recordingParallelPolicy(foldBudgets) });

    // Every agent was budgeted exactly once during the fold.
    expect(foldBudgets.length).toBe(N);
    // Each report's budget is a SHARE — comfortably under half the pool even at
    // N=3 (it shrinks further as the cohort grows), and strictly positive. This is
    // the structural fix: N concurrent reports can't collectively exhaust KV.
    for (const b of foldBudgets) {
      expect(b).toBeGreaterThan(0);
      expect(b).toBeLessThan(nCtx / 2);
    }
    expect(I1_nativeStoreSingleFiber(run).ok).toBe(true);
  });

  it('honors an explicit reportBudget as a fixed cap, bypassing headroom division (the low-effort path)', async () => {
    // With ample KV the headroom-derived budget would clamp to MAX_REPORT_BUDGET
    // (2048); an explicit reportBudget must win verbatim so a `quick`-effort run gets
    // the short reports it asked for regardless of how much KV happens to be free.
    const foldBudgets: number[] = [];
    await runPool({ nCtx: 8192, cellsUsed: 0, scripts: idleScripts(), policy: recordingParallelPolicy(foldBudgets, 256) });
    expect(foldBudgets.length).toBe(N);
    for (const b of foldBudgets) expect(b).toBe(256); // exact — not headroom-divided, not the 2048 cap
  });

  it('clamps the headroom-derived budget to MAX_REPORT_BUDGET (no report bloat under ample KV)', async () => {
    // One agent + a large context → headroom/N would be many thousands of tokens;
    // the fold caps it at MAX_REPORT_BUDGET (2048) so an early-Stop wind-down with
    // plenty of KV still doesn't ask the model for an essay.
    const foldBudgets: number[] = [];
    await runPool({ nCtx: 16384, cellsUsed: 0, scripts: idleScriptsN(1), policy: recordingParallelPolicy(foldBudgets) });
    expect(foldBudgets.length).toBe(1);
    expect(foldBudgets[0]).toBe(2048); // MAX_REPORT_BUDGET ceiling
  });
});
