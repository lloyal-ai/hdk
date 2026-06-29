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
const spawnEvents = (r: PoolRun) =>
  r.channelEvents.filter(e => e.type === 'agent:spawn');
const prefillCount = (r: PoolRun) => r.nativeCalls.filter(c => c.op === 'prefill').length;
const onFirstSpawn = (ev: { type: string }) => ev.type === 'agent:spawn';

describe('scenario: graceful wind-down (drain)', () => {
  it('reaps the whole active cohort on WindDown and recovers via the fold', async () => {
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0,
      scripts: activeScriptsN(N),
      policy: activePolicy('staggered'),
      windDownAfter: onFirstSpawn,
    });
    // Every active agent was reaped SPECIFICALLY by wind-down (a distinct reason
    // from pressure/time/maxTurns), and reaped in one tick (no stagger).
    expect(windDownDrops(run).length).toBe(N);
    // Every reaped agent was recovered (idle-no-result → onRecovery extract).
    expect(recoveryPrefills(run).length).toBe(N);
    // The batched recovery decode holds the single-fiber SEGV invariant.
    expect(I1_nativeStoreSingleFiber(run).ok).toBe(true);
    // The run terminated cleanly with a result.
    expect(run.result).toBeDefined();
  });

  it('FORCES the fold even when recoveryShape is staggered (wind-down overrides the shape)', async () => {
    const windStag = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: activeScriptsN(N), policy: activePolicy('staggered'), windDownAfter: onFirstSpawn });
    const windPar  = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: activeScriptsN(N), policy: activePolicy('parallel'),  windDownAfter: onFirstSpawn });
    // Baseline: the SAME staggered policy WITHOUT wind-down — agents run to STOP,
    // land idle-no-result, and the sweep recovers them one-at-a-time (staggered).
    const baseStag = await runPool({ nCtx: 8192, cellsUsed: 0, scripts: activeScriptsN(N), policy: activePolicy('staggered') });

    // All three recover every agent…
    expect(recoveryPrefills(windStag).length).toBe(N);
    expect(recoveryPrefills(windPar).length).toBe(N);
    expect(recoveryPrefills(baseStag).length).toBe(N);

    // …but wind-down with the STAGGERED shape takes the SAME native-prefill path
    // as the PARALLEL shape (it folded), and strictly FEWER prefills than the
    // staggered baseline that actually staggered. ⇒ wind-down forced the fold.
    expect(prefillCount(windStag)).toBe(prefillCount(windPar));
    expect(prefillCount(windStag)).toBeLessThan(prefillCount(baseStag));
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
