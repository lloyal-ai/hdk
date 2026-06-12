/**
 * Scenario: protected-tool dispatch is rejected at the pool level.
 *
 * RFC §10.4b: `authGuard-rejection` — confirms the authGuard fires when
 * the model emits a tool call against a `Tool.protected: true` tool and
 * the session holds no grant in `GrantStoreCtx`. Unit-level coverage
 * lives in `agents/test/authGuard.test.ts`; this scenario locks the
 * pool-level wiring: `useAgentPool` reads `Tool.protected` flags into
 * `PolicyConfig.protectedTools`, the authGuard's `nudge` action with
 * `guard: 'auth_reject'` is converted to a structured `tool:authReject`
 * trace event with the attempted tool name and the agent's `assignedApp`
 * attribution.
 *
 * What this locks:
 *   - `useAgentPool` auto-derives `protectedTools` from `Tool.protected`.
 *   - The authGuard runs INSIDE the pool's tick loop and produces a
 *     trace event distinct from generic nudges.
 *   - The event carries `attemptedTool` (audit attribution) and
 *     `assignedApp` (which app the spawn was tagged with).
 *   - No grant in context = fail-closed (no silent dispatch).
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import type { JsonSchema } from '../../../src/types';
import { runPool, STOP } from '../harness';

/** Minimal tool with `protected: true`. Body is irrelevant — the
 *  authGuard fires BEFORE execute() is reached. */
class ProtectedActionTool extends Tool<Record<string, unknown>> {
  readonly name = 'bank_transfer';
  readonly description = 'protected action — transfer funds';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  readonly protected = true as const;
  *execute(): Operation<unknown> {
    return { transferred: 1000 };
  }
}

describe('scenario: authGuard rejects protected tool calls without a grant (§10.4b)', () => {
  it('emits tool:authReject when an agent calls a protected tool without a grant', async () => {
    const tool = new ProtectedActionTool();
    const tools = new Map([[tool.name, tool as Tool]]);

    const run = await runPool({
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'bank_transfer', arguments: JSON.stringify({ to: 'attacker' }) },
      }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools,
      terminalTool: 'report',
      trace: true,
    });

    const reject = run.traceEvents.find((e) => e.type === 'tool:authReject');
    expect(reject).toBeDefined();
    expect(reject).toMatchObject({
      type: 'tool:authReject',
      attemptedTool: 'bank_transfer',
    });
  });

  it('records the agent id and lineage on the rejection event (audit attribution)', async () => {
    const tool = new ProtectedActionTool();
    const tools = new Map([[tool.name, tool as Tool]]);

    const run = await runPool({
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'bank_transfer', arguments: JSON.stringify({}) },
      }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools,
      terminalTool: 'report',
      trace: true,
    });

    const reject = run.traceEvents.find((e) => e.type === 'tool:authReject') as
      | { agentId: number; lineageHistory: unknown }
      | undefined;
    expect(reject?.agentId).toBeTypeOf('number');
    // lineageHistory is always defined on tool:authReject — empty if the
    // ancestor chain has no tool history yet, but the field is structural.
    expect(reject?.lineageHistory).toBeDefined();
  });

  it('does NOT call execute() on the protected tool (fail-closed, no side effect)', async () => {
    let executed = false;
    class SideEffectTool extends Tool<Record<string, unknown>> {
      readonly name = 'bank_transfer';
      readonly description = 'records side-effect on invocation';
      readonly parameters: JsonSchema = { type: 'object', properties: {} };
      readonly protected = true as const;
      *execute(): Operation<unknown> {
        executed = true;
        return {};
      }
    }
    const tools = new Map([['bank_transfer', new SideEffectTool() as Tool]]);

    await runPool({
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'bank_transfer', arguments: JSON.stringify({}) },
      }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools,
      terminalTool: 'report',
      trace: true,
    });

    expect(executed).toBe(false);
  });
});
