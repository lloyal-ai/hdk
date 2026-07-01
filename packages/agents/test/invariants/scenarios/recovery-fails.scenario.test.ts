/**
 * Scenario: a recovery that yields no terminal-tool call → pool:recoveryFailed
 *
 * Shape: agent free-texts (no voluntary terminal call), policy says idle → agent
 * dropped → recoverInline runs → the recovery decode produces output that
 * parseChatOutput finds NO terminal call in → finishRecovery reports the failure
 * (not silent).
 *
 * What this locks:
 *   - I29: recovery diagnostic completeness. Every recovery attempt that
 *     prefills a recovery prompt terminates with exactly one of
 *     `pool:recoveryReturn` or `pool:recoveryFailed`.
 *   - Failure reason + output excerpt are captured so ops can diagnose a failed
 *     recovery without re-running the job. The reason is `no_terminal_call` —
 *     the native tool-call path (parseChatOutput) found no call to extract,
 *     NOT a hand-rolled JSON.parse error.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

describe('scenario: recovery generates no terminal call', () => {
  it('drop → recoverInline output has no terminal call → pool:recoveryFailed with excerpt', async () => {
    const policy: AgentPolicy = {
      // Free-text every turn → idle drop → recoverInline runs (default staggered).
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
      shouldExit: () => false,
    };

    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 3000,
      // [1, STOP] initial turn → idle → recoverInline; [2, 3, STOP] recovery decode.
      // The script declares NO toolCall, so the mock's parseChatOutput returns no
      // terminal call for the recovery output → finishRecovery fails (not silent).
      scripts: [{ tokens: [1, STOP, 2, 3, STOP], content: 'unparseable prose' }],
      policy,
      terminalToolName: 'report',
      maxTurns: 5,
    });

    // Recovery prefill happened (the blocking recoverInline path, role=recovery).
    const recoveryPrefills = run.traceEvents.filter(
      e => e.type === 'branch:prefill' && (e as any).role === 'recovery',
    );
    expect(recoveryPrefills.length).toBeGreaterThanOrEqual(1);

    // Every recovery prefill is followed by exactly one diagnostic event.
    const reports = run.traceEvents.filter(e => e.type === 'pool:recoveryReturn');
    const failures = run.traceEvents.filter(e => e.type === 'pool:recoveryFailed');
    expect(reports.length + failures.length).toBe(recoveryPrefills.length);

    // This run must have produced a failure (no terminal call in the output).
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const f = failures[0] as any;
    expect(f.reason).toMatch(/no_terminal_call/);
    expect(typeof f.outputExcerpt).toBe('string');
    expect(f.outputExcerpt.length).toBeGreaterThan(0);

    // The failure is announced on the CHANNEL too (`agent:failed`), not just the
    // trace — the UI consumes `agent:failed` to leave the "writing report" state.
    // (Deleting the emit would keep the trace assertions above green but hang the UI.)
    const channelFailed = run.channelEvents.filter(e => e.type === 'agent:failed');
    expect(channelFailed.length).toBe(failures.length);
    expect((channelFailed[0] as { reason: string }).reason).toMatch(/no_terminal_call/);
  });

  it('recovery output has only a NON-terminal call + terminalToolName set → no_terminal_call (Fix A)', async () => {
    // shouldExit reaps the agent before any voluntary result → recovery runs. The recovery
    // decode parses to a NON-terminal `web_search` call; with terminalToolName 'report',
    // finishRecovery must NOT treat it as the report — require the terminal match, else fail.
    // Pre-Fix-A: `?? toolCalls[0]` set the result from web_search's args → pool:recoveryReturn.
    const policy: AgentPolicy = {
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
      shouldExit: () => true,
    };

    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 3000,
      scripts: [{
        tokens: [2, 3, STOP],
        toolCall: { name: 'web_search', arguments: '{"query":"x"}' },
      }],
      policy,
      terminalToolName: 'report',
      maxTurns: 5,
    });

    const reports = run.traceEvents.filter(e => e.type === 'pool:recoveryReturn');
    const failures = run.traceEvents.filter(e => e.type === 'pool:recoveryFailed');
    expect(reports.length).toBe(0); // the non-terminal call must NOT be used as the report
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect((failures[0] as { reason: string }).reason).toMatch(/no_terminal_call/);
  });
});
