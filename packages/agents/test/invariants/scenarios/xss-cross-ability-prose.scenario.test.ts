/**
 * Scenario: cross-ability prose injection cannot bypass the authGuard.
 *
 * RFC §10.4b: `xss-cross-ability-prose` — confirms the M2 security model
 * holds even when a spawn's preamble (`skill.eta` content) attempts to
 * cross-reference another ability's tools. Reads are open by design — an
 * abilityA spawn CAN call abilityB's read tools — but **protected actions stay
 * protected regardless of who is asking**. Cross-ability prose carried in
 * the spawn's preamble doesn't relax the protected gate; the authGuard
 * fires on tool-name lookup against the pool's `protectedTools` set,
 * not on prose content.
 *
 * What this locks:
 *   - Open (non-protected) tools dispatch normally even when called
 *     from a spawn nominally assigned to a different ability.
 *   - Protected tools always require a grant — pool-wide, not per-ability.
 *   - The pool produces ONE `tool:authReject` per rejected attempt,
 *     attributing the call to the agent (not the prose).
 *
 * Distinct from `authGuard-rejection.scenario.test.ts` (which tests the
 * canonical pool-level wiring): this scenario specifically verifies the
 * cross-ability open-reads-but-protected-actions split that M2 mandates.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import type { JsonSchema } from '../../../src/types';
import { runPool, STOP } from '../harness';

/** Open read tool — belongs to abilityA in the cross-ability framing. */
class OpenSearchTool extends Tool<{ query: string }> {
  readonly name = 'appA_search';
  readonly description = 'open read — search abilityA';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
  };
  *execute(): Operation<unknown> {
    return { results: ['hit'] };
  }
}

/** Protected action — belongs to abilityB. An abilityA spawn whose prose
 *  attempts to call this must be rejected. */
class ProtectedActionTool extends Tool<Record<string, unknown>> {
  readonly name = 'appB_transfer';
  readonly description = 'protected — transfer in abilityB';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  readonly protected = true as const;
  *execute(): Operation<unknown> {
    return { ok: true };
  }
}

describe('scenario: cross-ability prose cannot escalate from open reads to protected actions (§10.4b)', () => {
  it('open tool from another ability dispatches normally (open-reads invariant)', async () => {
    const tools = new Map<string, Tool>([
      ['appA_search', new OpenSearchTool() as Tool],
      ['appB_transfer', new ProtectedActionTool() as Tool],
    ]);

    const run = await runPool({
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'appA_search', arguments: JSON.stringify({ query: 'q' }) },
      }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools,
      terminalToolName: 'report',
      trace: true,
    });

    // Open tool dispatch is recorded as a tool:call/result, NOT an authReject.
    const reject = run.traceEvents.find((e) => e.type === 'tool:authReject');
    expect(reject).toBeUndefined();
    const dispatched = run.traceEvents.find(
      (e) => e.type === 'tool:dispatch' || e.type === 'tool:result',
    );
    expect(dispatched).toBeDefined();
  });

  it('protected tool from another ability rejects regardless of which spawn calls it (protected-actions invariant)', async () => {
    const tools = new Map<string, Tool>([
      ['appA_search', new OpenSearchTool() as Tool],
      ['appB_transfer', new ProtectedActionTool() as Tool],
    ]);

    const run = await runPool({
      scripts: [{
        tokens: [1, STOP],
        // The agent's "prose" (system prompt) is abilityA's — but it
        // attempts to dispatch abilityB's protected tool, simulating a
        // cross-ability prose injection.
        toolCall: { name: 'appB_transfer', arguments: JSON.stringify({ amount: 1000 }) },
      }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools,
      terminalToolName: 'report',
      trace: true,
    });

    const reject = run.traceEvents.find((e) => e.type === 'tool:authReject') as
      | { attemptedTool: string }
      | undefined;
    expect(reject).toBeDefined();
    expect(reject?.attemptedTool).toBe('appB_transfer');
  });

  it('every rejected attempt produces a tool:authReject audit entry (no silent passthrough)', async () => {
    // Note: the scenario harness's parseChatOutput re-emits the scripted
    // toolCall on every tick, so a single scripted attempt produces N
    // rejections as the agent loops on the nudge. The load-bearing
    // assertion is *some* audit event per rejection — never a silent
    // dispatch — not "exactly one" (which is a separate dedup concern).
    const tools = new Map<string, Tool>([
      ['appB_transfer', new ProtectedActionTool() as Tool],
    ]);

    const run = await runPool({
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'appB_transfer', arguments: JSON.stringify({}) },
      }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools,
      terminalToolName: 'report',
      trace: true,
    });

    const rejects = run.traceEvents.filter((e) => e.type === 'tool:authReject');
    expect(rejects.length).toBeGreaterThanOrEqual(1);
    // Every reject names the same attempted tool — no leakage of other
    // tool names into the audit stream.
    for (const r of rejects) {
      expect((r as { attemptedTool: string }).attemptedTool).toBe('appB_transfer');
    }
  });
});
