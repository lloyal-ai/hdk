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
 * test. The recovery prompt is a parameter so the pressure-downgrade test can
 * make Σ(prefill) dwarf the available headroom.
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

const recoveryPrefills = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'branch:prefill' && (e as { role?: string }).role === 'recovery');
const prefillCount = (r: PoolRun) =>
  r.nativeCalls.filter(c => c.op === 'prefill').length;

// Each agent: main turn [1, STOP], then recovery decode [2, STOP]. The mock
// emits non-JSON text from token 2 → recovery lands on `pool:recoveryFailed`
// (we assert the batching *shape*, not parse success — the mock can't produce
// grammar-valid JSON).
const idleScripts = () =>
  Array.from({ length: N }, () => ({ tokens: [1, STOP, 2, STOP], content: 'prose findings' }));

describe('scenario: parallel recovery (recoveryShape)', () => {
  it('parallel batches the whole idle-no-result cohort into ONE prefill (vs N staggered)', async () => {
    // Small recovery prompt + generous nCtx → the up-front pressure gate passes
    // → the batched path runs. Same scripts/policy except the reap shape, so
    // root + spawn prefills are identical between the two runs.
    const prompt = { system: 's', user: 'u' };
    const par = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: idleScripts(), policy: idleNoResultPolicy('parallel', prompt) });
    const stag = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: idleScripts(), policy: idleNoResultPolicy('staggered', prompt) });

    // Both shapes recover every agent (one recovery prefill trace each).
    expect(recoveryPrefills(par).length).toBe(N);
    expect(recoveryPrefills(stag).length).toBe(N);

    // THE batching proof: the only difference between the runs is the reap
    // shape, so parallel collapsing N recovery prefills into one batched
    // `store.prefill` shows up as exactly (N-1) fewer native prefill calls.
    expect(prefillCount(par)).toBe(prefillCount(stag) - (N - 1));

    // The batched decode must hold the single-fiber invariant (the SEGV guard)…
    expect(I1_nativeStoreSingleFiber(par).ok).toBe(true);
    // …and every recovering agent still gets exactly one diagnostic (no loss).
    expect(I29_recoveryDiagnostic(par).ok).toBe(true);
  });

  it('parallel downgrades to staggered when the cohort prefill exceeds headroom', async () => {
    // Huge recovery prompt → Σ(prefill) far exceeds `remaining`, so the
    // up-front pressure gate forces the per-agent staggered fallback even
    // though recoveryShape is 'parallel'. Nothing is lost.
    const big = 'x'.repeat(4000); // ~1000 tokens each; ~6000 across the cohort
    const prompt = { system: big, user: big };
    const parPressure = await runPool({ nCtx: 4096, cellsUsed: 0, scripts: idleScripts(), policy: idleNoResultPolicy('parallel', prompt) });
    const stagPressure = await runPool({ nCtx: 4096, cellsUsed: 0, scripts: idleScripts(), policy: idleNoResultPolicy('staggered', prompt) });

    // Downgrade ⇒ parallel ran the staggered path ⇒ identical native prefill
    // count to the staggered baseline (no N→1 collapse).
    expect(prefillCount(parPressure)).toBe(prefillCount(stagPressure));

    // Every agent still recovered — the downgrade loses no reports.
    expect(recoveryPrefills(parPressure).length).toBe(N);
    expect(I29_recoveryDiagnostic(parPressure).ok).toBe(true);
  });
});
