import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP, chain } from '../harness';
import type { PoolRun } from '../harness';
import { I1_nativeStoreSingleFiber } from '../predicates';

const N = 3;

/**
 * A policy whose agents never voluntarily exit within the test window — long
 * token scripts keep them `active` so a `WindDown` signal reaps them mid-flight
 * (drain). `recoveryShape` is a parameter so the tests can prove wind-down forces
 * the fold REGARDLESS of the configured shape. `onRecovery` always extracts.
 */
function activePolicy(shape: 'staggered' | 'parallel'): AgentPolicy {
  return {
    onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
    onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
    shouldExit: () => false,
    recoveryShape: shape,
  };
}

// Long scripts: enough produce-tokens that agents are still `active` when the
// wind-down trigger fires (on the first agent:spawn), then exhaust to STOP so a
// NON-wind-down baseline still terminates (and staggers its recovery).
const activeScriptsN = (n: number) =>
  Array.from({ length: n }, () => ({ tokens: [...Array(8).fill(1), STOP], content: 'partial findings' }));

const windDownDrops = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'pool:agentDrop' && (e as { reason?: string }).reason === 'wind_down');
const recoveryPrefills = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'branch:prefill' && (e as { role?: string }).role === 'recovery');
// role='toolResult' prefills are the IN-LOOP recovery turns (handleRecover → SETTLE);
// in these no-tool scenarios they are exactly the in-loop reaps.
const inLoopPrefills = (r: PoolRun) =>
  r.traceEvents.filter(e => e.type === 'branch:prefill' && (e as { role?: string }).role === 'toolResult');
const spawnEvents = (r: PoolRun) =>
  r.channelEvents.filter(e => e.type === 'agent:spawn');
const onFirstSpawn = (ev: { type: string }) => ev.type === 'agent:spawn';

describe('scenario: graceful wind-down (drain)', () => {
  it('reaps the whole active cohort on WindDown and recovers them in-loop', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: activeScriptsN(N),
      policy: activePolicy('staggered'),
      windDownAfter: onFirstSpawn,
    });
    // Every active agent was reaped SPECIFICALLY by wind-down (a distinct reason
    // from pressure/time/maxTurns), and reaped in one tick (no stagger).
    expect(windDownDrops(run).length).toBe(N);
    // Every reaped agent had its recovery turn injected IN-LOOP (handleRecover →
    // SETTLE, role=toolResult) — wind-down always bin-packs the drain.
    expect(inLoopPrefills(run).length).toBe(N);
    // The bin-packed recovery decode holds the single-fiber SEGV invariant.
    expect(I1_nativeStoreSingleFiber(run).ok).toBe(true);
    // The run terminated cleanly with a result.
    expect(run.result).toBeDefined();
  });

  it('FORCES in-loop recovery even when recoveryShape is staggered (wind-down overrides the shape)', async () => {
    const windStag = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: activeScriptsN(N), policy: activePolicy('staggered'), windDownAfter: onFirstSpawn });
    const windPar  = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: activeScriptsN(N), policy: activePolicy('parallel'),  windDownAfter: onFirstSpawn });
    // Baseline: the SAME staggered policy WITHOUT wind-down — agents run to STOP,
    // land idle-no-result, and the termination sweep recovers them one-at-a-time
    // through the BLOCKING recoverInline (role=recovery, zero in-loop prefills).
    const baseStag = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: activeScriptsN(N), policy: activePolicy('staggered') });

    // Wind-down — staggered shape AND parallel shape alike — injects every reap's
    // recovery turn IN-LOOP (role=toolResult): the staggered shape was overridden.
    expect(inLoopPrefills(windStag).length).toBe(N);
    expect(inLoopPrefills(windPar).length).toBe(N);

    // The staggered baseline (no wind-down) takes the blocking path instead — NO
    // in-loop recovery turns, every recovery via recoverInline. That contrast is
    // the proof wind-down forced the in-loop shape regardless of the policy.
    expect(inLoopPrefills(baseStag).length).toBe(0);
    expect(recoveryPrefills(baseStag).length).toBe(N);
  });

  it('leaves an agent mid-terminal-tool to finish its voluntary report; reaps its free-text sibling', async () => {
    // Agent 0 latches currentTool=report (partialToolCall) on its first observe(),
    // so the reap-branch terminal guard protects it — it runs on to STOP and emits
    // its voluntary report. Agent 1 is free-text → reaped by wind-down. Fire AFTER
    // the first produce so the latch has happened. (Uses `terminalToolName`, the
    // field the harness actually reads; the declared `PoolSpec.terminalTool` is a
    // pre-existing dead field.)
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      terminalToolName: 'report',
      scripts: [
        { tokens: [...Array(12).fill(1), STOP], partialToolCall: { name: 'report', arguments: '{"result":"done"}' }, toolCall: { name: 'report', arguments: '{"result":"done"}' } },
        { tokens: [...Array(8).fill(1), STOP], content: 'partial findings' },
      ],
      policy: activePolicy('staggered'),
      windDownAfter: ev => ev.type === 'agent:produce',
    });
    const dropped = new Set(windDownDrops(run).map(e => (e as { agentId: number }).agentId));
    // Exactly one agent was wind-down-reaped — the free-text one, NOT the reporter.
    expect(dropped.size).toBe(1);
    expect(dropped.has(0)).toBe(false);
    expect(run.result).toBeDefined();
  });

  it('stops spawning: a chain orchestrator does NOT spawn the next step after WindDown', async () => {
    // chain() spawns task 0, waits for it, then spawns task 1… On wind-down the
    // orchestrator is halted, so reaping task 0 must NOT cascade into task 1.
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: activeScriptsN(3),
      orchestrate: chain([0, 1, 2], (i) => ({ task: { content: `Task ${i}`, systemPrompt: 'You are an agent.', seed: i } })),
      policy: activePolicy('staggered'),
      windDownAfter: ev => ev.type === 'agent:produce',
    });
    // Only the first chain step ever spawned — the orchestrator was halted before
    // the second could be issued.
    expect(spawnEvents(run).length).toBe(1);
    expect(windDownDrops(run).length).toBe(1);
    expect(run.result).toBeDefined();
  });

  it('default-off: no WindDown provided ⇒ no wind-down reaps (today\'s termination)', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: activeScriptsN(N),
      policy: activePolicy('staggered'),
      // no windDownAfter ⇒ no WindDown context provided at all
    });
    expect(windDownDrops(run).length).toBe(0);
    expect(run.result).toBeDefined();
  });
});
