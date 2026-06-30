import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';
import type { PoolRun } from '../harness';
import { I1_nativeStoreSingleFiber } from '../predicates';

const N = 3;

// The recovery report is a TERMINAL-tool call: the mock's script-driven
// parseChatOutput returns this for the recovery output (same as the real model
// emitting a Hermes `<tool_call><function=report>`), so finishRecovery extracts
// `result` and the in-loop recovery SETS the agent's result. The grammar/maxLength
// is verified against the real model; here the mock ignores the grammar, so we
// assert the PATH, the co-batching, and the CAP (the token-stop, observable as
// `pool:recoveryProduce.tokenCount`).
const REPORT_CALL = { name: 'report', arguments: '{"result":"recovered"}' };

/**
 * Every agent drops to idle WITHOUT a voluntary result on its first stop
 * (`free_text_stop`), so each is recovered: `parallel` injects the recovery turn
 * IN-LOOP (handleRecover → SETTLE admission → bin-packed decode); `staggered`
 * blocks via `recoverInline`. `reportBudget` is the FIXED per-report cap `b`.
 */
function idleNoResultPolicy(
  shape: 'staggered' | 'parallel',
  reportBudget?: number,
): AgentPolicy {
  return {
    onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
    onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
    shouldExit: () => false,
    recoveryShape: shape,
    ...(reportBudget !== undefined ? { reportBudget } : {}),
  };
}

// role='recovery' → the BLOCKING `recoverInline` path (staggered + the stall-break
// fallback). role='toolResult' → the IN-LOOP recovery turn prefilled through SETTLE
// (the parallel path). In these no-tool scenarios `toolResult` prefills are exactly
// the in-loop recovery turns.
const inlinePrefills = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'branch:prefill' && (e as { role?: string }).role === 'recovery');
const inLoopPrefills = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'branch:prefill' && (e as { role?: string }).role === 'toolResult');
const recoveryProduce = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'pool:recoveryProduce');
const recoveryReturn = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'pool:recoveryReturn');

// Each agent: main turn [1, STOP], then a short recovery decode [1, STOP].
const idleScriptsN = (n: number) =>
  Array.from({ length: n }, () => ({ tokens: [1, STOP, 1, STOP], content: 'prose findings', toolCall: REPORT_CALL }));
const idleScripts = () => idleScriptsN(N);

/**
 * Parallel recovery is a turn (#77): a killed-without-result agent gets the
 * recovery prompt injected IN-LOOP via the nudge/SETTLE path — prefilled as a
 * `toolResult`, re-activated with the native terminal-tool grammar, and decoded
 * BIN-PACKED in the tick loop alongside live siblings (one O(1) llama_decode per
 * tick, regardless of how many recover at once). The per-report cap is the budget
 * `b` (prompt advisory + token-stop), sized so the WHOLE cohort's prefill+decode
 * fits headroom in one tick — so every reaped agent recovers, nothing is deferred or
 * lost. `staggered` (high effort) is the lossless serial path — blocking
 * `recoverInline`, uncapped — and is unchanged.
 */
describe('scenario: parallel recovery (in-loop via SETTLE)', () => {
  it('recovers every parallel agent IN-LOOP via SETTLE — never the blocking recoverInline', async () => {
    const r = await runPool({
      nCtx: 8192, cellsUsed: 0, scripts: idleScripts(),
      policy: idleNoResultPolicy('parallel'),
    });

    // Every agent's recovery turn was prefilled through SETTLE (role=toolResult)…
    expect(inLoopPrefills(r).length).toBe(N);
    // …and NONE went through the blocking private-loop recoverInline (role=recovery).
    expect(inlinePrefills(r).length).toBe(0);
    // Every agent extracted a result in-loop (no loss).
    expect(recoveryProduce(r).length).toBe(N);
    expect(recoveryReturn(r).length).toBe(N);
    // The bin-packed decode holds the single-fiber invariant (the SEGV guard).
    expect(I1_nativeStoreSingleFiber(r).ok).toBe(true);
    expect(r.result).toBeDefined();
  });

  it('stall-regression: a killed agent\'s recovery decodes bin-packed in a COMMIT with a LIVE sibling', async () => {
    // Agent 0 keeps producing (the live sibling); agent 1 stops early and is
    // recovered MID-RUN. The regression (the bug this whole change fixes): the old
    // recoverInline ran agent 1's recovery in a private blocking loop that froze
    // agent 0 for the duration. In-loop, agent 1's recovery tokens ride the tick's
    // batched COMMIT *with* agent 0's live tokens — proven by a branchCount≥2 commit
    // landing strictly inside agent 1's recovery window.
    const r = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [
        { tokens: [...Array(8).fill(1), STOP, 1, STOP], content: 'long live sibling', toolCall: REPORT_CALL },
        { tokens: [1, STOP, 1, STOP], content: 'short recover me', toolCall: REPORT_CALL },
      ],
      policy: idleNoResultPolicy('parallel'),
    });

    // The short agent recovers FIRST; derive its id from the first recovery-turn
    // prefill (role=toolResult) rather than hardcoding a fork handle. Its recovery
    // window runs from that prefill to its recovery extraction (pool:recoveryProduce).
    const prefill = r.traceEvents.find(
      e => e.type === 'branch:prefill' && (e as { role?: string }).role === 'toolResult',
    );
    expect(prefill).toBeDefined();
    const recoveringId = (prefill as { branchHandle: number }).branchHandle;
    const produce = r.traceEvents.find(
      e => e.type === 'pool:recoveryProduce' && (e as { agentId?: number }).agentId === recoveringId,
    );
    expect(produce).toBeDefined();
    const tPrefill = (prefill as { ts: number }).ts;
    const tProduce = (produce as { ts: number }).ts;

    // A batched commit (branchCount≥2 ⇒ recovering agent 1 + live agent 0 together)
    // lands inside the window — recovery co-batched with the live sibling, no block.
    const coBatched = r.nativeCalls.filter(
      c => c.op === 'commit' && c.branchCount >= 2 && c.tStart > tPrefill && c.tStart < tProduce,
    );
    expect(coBatched.length).toBeGreaterThanOrEqual(1);

    // And it never fell back to the blocking recoverInline path.
    expect(inlinePrefills(r).length).toBe(0);
    expect(recoveryReturn(r).some(e => (e as { agentId?: number }).agentId === recoveringId)).toBe(true);
    expect(I1_nativeStoreSingleFiber(r).ok).toBe(true);
  });

  it('recovery budget draws from the hardLimit RESERVE, not softLimit (floor regression — a3 truncation)', async () => {
    // The floor-fix: `b` = (remaining − hardLimit − …)/aliveCount, so a LARGE softLimit
    // (the model NUDGE floor — no mechanical meaning for recovery) does NOT shrink the
    // forced report. The OLD code drew from `remaining − softLimit`, so a big softLimit
    // truncated recovery reports (the TC1 a3 "missing Moat #2"). Here softLimit=7000 sits
    // far above hardLimit=512 with ~8k cells free: the budget reaches MAX (2048), proven by
    // the token-stop landing at 2048 on an over-long recovery script. A softLimit-based
    // floor would have starved it to ~500 — truncating the report.
    const r = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [{ tokens: [1, STOP, ...Array(2100).fill(1), STOP], content: 'over-long recovery', toolCall: REPORT_CALL }],
      policy: { ...idleNoResultPolicy('parallel'), pressureThresholds: { softLimit: 7000, hardLimit: 512 } },
    });
    expect(recoveryProduce(r).length).toBe(1);
    // The cap landed at MAX (2048) — sized from the hardLimit reserve. The old softLimit
    // floor would have produced ~500 here (remaining − softLimit, not remaining − hardLimit).
    expect((recoveryProduce(r)[0] as { tokenCount: number }).tokenCount).toBe(2048);
    expect(recoveryReturn(r).length).toBe(1);
    expect(I1_nativeStoreSingleFiber(r).ok).toBe(true);
  });

  it('reap UNDER negative headroom still recovers IN-LOOP from the hardLimit reserve (SETTLE-admission floor)', async () => {
    // The production reap shape: an agent born with headroom (remaining > softLimit, so it
    // passes the `pressure_init` spawn guard) RESEARCHES the KV down BELOW softLimit, then
    // reaps and must recover. At reap `headroom = remaining − softLimit < 0`, so the OLD
    // SETTLE gate (`cost > headroom`) DEFERS every recovery → stall-break → serial
    // `recoverInline` (role=recovery). The NEW gate budgets extracting items against
    // `headroom + reserveBand` (= remaining − hardLimit) → it ADMITS in-loop (role=toolResult).
    // Born at remaining 3192 (> soft 3000); ~400 research commits drain it to ≈2750
    // (headroom ≈ −250, but remaining − hardLimit ≈ 2240 — plenty for the report).
    const r = await runPool({
      nCtx: 8192, cellsUsed: 5000,
      scripts: [{ tokens: [...Array(400).fill(1), STOP, 1, STOP], content: 'research then reap', toolCall: REPORT_CALL }],
      policy: { ...idleNoResultPolicy('parallel'), pressureThresholds: { softLimit: 3000, hardLimit: 512 } },
    });
    // Recovered (no loss), IN-LOOP via SETTLE — NOT the serial recoverInline the old
    // softLimit floor would have forced under this negative headroom.
    expect(recoveryReturn(r).length).toBe(1);
    expect(inLoopPrefills(r).length).toBeGreaterThanOrEqual(1);
    expect(inlinePrefills(r).length).toBe(0);
    expect(I1_nativeStoreSingleFiber(r).ok).toBe(true);
  });

  it('token-stop caps an over-long report at the fixed budget `b` (salvaged, not lost)', async () => {
    // The cap that closes the deadlock: a non-compliant report that runs past its
    // word advisory is force-finished at `b` tokens rather than decoding unbounded.
    // reportBudget=4; the recovery script would emit 8 tokens, but the token-stop
    // fires at 4 — and the partial report is still salvaged (no loss).
    const r = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [{ tokens: [1, STOP, 1, 1, 1, 1, 1, 1, 1, 1, STOP], content: 'x', toolCall: REPORT_CALL }],
      policy: idleNoResultPolicy('parallel', 4),
    });
    expect(inLoopPrefills(r).length).toBe(1);
    // The report was cut at exactly the budget — not the 8 the script would produce.
    expect((recoveryProduce(r)[0] as { tokenCount: number }).tokenCount).toBe(4);
    // …and the (partial) call was still extracted — the cap bounds, never drops.
    expect(recoveryReturn(r).length).toBe(1);
    expect(I1_nativeStoreSingleFiber(r).ok).toBe(true);
  });

  it('a simultaneous cohort reap recovers EVERY agent in-loop — adaptive `b` fits them all in one tick (loss regression)', async () => {
    // The live failure this fix closes: a whole cohort hits the time limit on the SAME
    // tick (the flat+medium run reaped 4 agents at 358s). The old SETTLE admission charged
    // each recovery item (prompt + report-budget) against headroom and DEFERRED the
    // overflow — and when the pool terminated after the admitted ones finished, the
    // deferred agents' findings were LOST. Now `b` is sized in handleRecover so
    // aliveCount·(prompt + b) ≤ headroom: the cohort's recovery turns all prefill + decode
    // together in ONE batched tick (O(1) in branch count), nothing defers, nothing is lost.
    // cellsUsed simulates a partly-filled KV so the adaptive sizing actually bites.
    const r = await runPool({
      nCtx: 4096, cellsUsed: 1024, scripts: idleScripts(),
      policy: idleNoResultPolicy('parallel'), // ADAPTIVE budget — the production (low/med) path
    });
    expect(recoveryReturn(r).length).toBe(N);    // every agent recovered — ZERO loss (the headline)
    expect(recoveryProduce(r).length).toBe(N);
    expect(inLoopPrefills(r).length).toBe(N);     // …all in-loop in one tick (admitted together, not deferred)
    expect(inlinePrefills(r).length).toBe(0);     // …never the serial recoverInline fallback
    expect(I1_nativeStoreSingleFiber(r).ok).toBe(true);
    expect(r.result).toBeDefined();
  });

  it('salvages a TRUNCATED terminal call (token-stop mid-call) — clean result, no JSON wrapper', async () => {
    // When the token-stop cuts mid-tool-call, parseChatOutput yields unclosed JSON
    // (`{"result":"…partial`). extractTerminalResult must recover the `result` body
    // and unescape it — NOT leak the `{"result":"` wrapper into the finding.
    const r = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [{
        tokens: [1, STOP, 1, STOP], content: 'x',
        toolCall: { name: 'report', arguments: '{"result":"clean partial body' }, // truncated, no close
      }],
      policy: idleNoResultPolicy('parallel'),
    });
    const recovered = r.channelEvents.filter(e => e.type === 'agent:recovered');
    expect(recovered.length).toBe(1);
    expect((recovered[0] as { result: string }).result).toBe('clean partial body');
  });

  it('an extracting agent is EXEMPT from re-kill — its forced report is never lost mid-decode', async () => {
    // The decision-boundary's lost-report failure mode: once an agent is producing
    // its forced recovery report (extracting), a subsequent kill verdict must NOT
    // reap it again — that would discard the very report recovery exists to save.
    // `shouldExit: always` kills the agent on its first active tick (→ recovery),
    // then keeps voting kill every tick; the extracting agent must ride through.
    const alwaysExit: AgentPolicy = {
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
      shouldExit: () => true,
      recoveryShape: 'parallel',
    };
    const r = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: [{ tokens: [1, STOP], content: 'killed before producing', toolCall: REPORT_CALL }],
      policy: alwaysExit,
    });

    // It entered recovery (in-loop) exactly once…
    expect(inLoopPrefills(r).length).toBe(1);
    // …was reaped exactly ONCE (the initial kill), never re-killed while extracting…
    expect(r.traceEvents.filter(e => e.type === 'pool:agentDrop').length).toBe(1);
    // …and its report survived to completion (not lost).
    expect(recoveryReturn(r).length).toBe(1);
    expect(I1_nativeStoreSingleFiber(r).ok).toBe(true);
    expect(r.result).toBeDefined();
  });

  it('without an explicit reportBudget the cap ADAPTS to headroom ÷ live agents — more agents, shorter reports', async () => {
    // The default cap is a fair share of CURRENT headroom across the live agents,
    // not a fixed number: recovering alone licenses a longer report than recovering
    // as one of many. A recovery that would run long is token-stopped at that
    // adaptive `b`, so the per-report token count is strictly smaller with more
    // co-alive agents. (No reportBudget → the adaptive path.)
    const longRecovery = (n: number) =>
      Array.from({ length: n }, () => ({ tokens: [1, STOP, ...Array(2200).fill(1), STOP], content: 'x', toolCall: REPORT_CALL }));
    const solo = await runPool({ nCtx: 4096, cellsUsed: 0, scripts: longRecovery(1), policy: idleNoResultPolicy('parallel') });
    const crowd = await runPool({ nCtx: 4096, cellsUsed: 0, scripts: longRecovery(6), policy: idleNoResultPolicy('parallel') });
    const soloCap = (recoveryProduce(solo)[0] as { tokenCount: number }).tokenCount;
    const crowdCap = Math.min(...recoveryProduce(crowd).map(e => (e as { tokenCount: number }).tokenCount));
    expect(crowdCap).toBeLessThan(soloCap); // headroom/6 < headroom/1
    expect(recoveryReturn(crowd).length).toBe(6); // …and the whole crowd still recovered
  });

  it('staggered (high effort) recovers via the blocking recoverInline path, UNCAPPED (lossless) — unchanged', async () => {
    // The lossless path: each report serializes through recoverInline and owns full
    // headroom — NO token-stop, so even with a reportBudget set the report runs to
    // its natural stop. This is what `parallel` trades away for responsiveness.
    const r = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: Array.from({ length: N }, () => ({
        tokens: [1, STOP, 1, 1, 1, 1, 1, 1, 1, 1, STOP], content: 'prose', toolCall: REPORT_CALL,
      })),
      policy: idleNoResultPolicy('staggered', 4), // budget set, but staggered ignores the token-stop
    });

    // Every agent recovered via recoverInline (role=recovery), none in-loop.
    expect(inlinePrefills(r).length).toBe(N);
    expect(inLoopPrefills(r).length).toBe(0);
    // Uncapped: each report produced all 8 tokens (the full script), NOT cut at b=4.
    for (const p of recoveryProduce(r)) expect((p as { tokenCount: number }).tokenCount).toBe(8);
    expect(recoveryReturn(r).length).toBe(N);
    expect(I1_nativeStoreSingleFiber(r).ok).toBe(true);
  });
});
