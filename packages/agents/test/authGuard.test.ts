/**
 * Tests for the framework-injected authGuard — RFC §3.2 M2 / §5.3c.
 *
 * The authGuard runs inside `DefaultAgentPolicy.onProduced` ahead of the
 * dedup guards and rejects any tool call whose name is `protected`
 * (in `config.protectedTools`) for which the session holds no grant
 * (`config.grants`). Reads/gather tools are OPEN — the boundary moved
 * into the tool, not app membership. Tests verify:
 *
 * 1. **Open tools pass through.** A non-protected tool emerges as a
 *    `tool_call` regardless of grants.
 * 2. **Protected without a grant rejects with `guard: 'auth_reject'`.**
 *    The `nudge` carries the canonical message and the `guard`
 *    discriminant the pool uses to route the `tool:authReject` event.
 * 3. **Protected WITH a grant passes.** A granted protected tool
 *    dispatches normally — trust changes privileges, not behaviour.
 * 4. **No protected tools = fully open.** With an empty/absent
 *    `protectedTools` set the authGuard never fires.
 * 5. **authGuard fires BEFORE dedup guards.** A duplicate call to a
 *    protected, ungranted tool returns the auth message, NOT the dedup
 *    message — security observability over dedup observability.
 * 6. **Terminal tool bypasses the authGuard.** The harness-owned
 *    terminal tool routes to `return` even when protected tools exist —
 *    agents can always submit findings.
 * 7. **`'*'` ToolGuard matches every call** and can read `config`.
 *
 * Together these lock the M2 invariant: dispatch-time protected-tool
 * rejection is OBSERVABLE (distinct `guard` value) and STRICT
 * (fail-closed, no silent passthrough even when another guard would also
 * reject).
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy, type PolicyConfig, type ToolGuard } from '../src/AgentPolicy';
import { Agent } from '../src/Agent';
import { createMockBranch } from './helpers/mock-branch';

const FMT = {
  format: 0,
  reasoningFormat: 0,
  generationPrompt: '',
  parser: '',
  grammar: '',
  grammarLazy: false,
  grammarTriggers: [],
};

const BASE: Omit<PolicyConfig, 'protectedTools' | 'grants'> = {
  maxTurns: 20,
  terminalToolName: 'report',
  hasNonTerminalTools: true,
};

function cfg(opts?: {
  protectedTools?: Iterable<string>;
  grants?: Iterable<string>;
}): PolicyConfig {
  return {
    ...BASE,
    protectedTools: opts?.protectedTools ? new Set(opts.protectedTools) : new Set(),
    grants: opts?.grants ? new Set(opts.grants) : new Set(),
  };
}

function makeAgent(opts: {
  assignedApp?: string | null;
  toolHistory?: Array<{ name: string; args: string }>;
} = {}) {
  const branch = createMockBranch();
  const agent = new Agent({
    id: 1,
    parentId: 0,
    branch: branch as never,
    fmt: FMT,
    assignedApp: opts.assignedApp ?? null,
  });
  agent.transition('active');
  for (const h of opts.toolHistory ?? []) {
    agent.recordToolResult({
      name: h.name,
      args: h.args,
      resultTokenCount: 100,
      contextAfterPercent: 80,
      timestamp: 0,
    });
  }
  return agent;
}

function pressure(remaining = 5000, nCtx = 16384) {
  return {
    headroom: remaining - 1024,
    critical: remaining < 128,
    remaining,
    nCtx,
    cellsUsed: nCtx - remaining,
    percentAvailable: nCtx > 0 ? Math.max(0, Math.round((remaining / nCtx) * 100)) : 100,
    canFit: (n: number) => n <= remaining - 1024,
    softLimit: 1024,
    hardLimit: 128,
  };
}

function tc(name: string, args: Record<string, unknown> = {}) {
  return { name, arguments: JSON.stringify(args) };
}

// §10.4 codification: the `P-no-ungranted-protected-dispatch` predicate
// from the App-protocol RFC lives in this file. Its canonical assertion
// is the named test below ("P-no-ungranted-protected-dispatch (§10.4)"),
// which mirrors the behaviour test at line ~123 under the predicate name
// so a grep for `P-no-ungranted-protected-dispatch` lands here.

describe('authGuard (default ToolGuard)', () => {
  it('P-no-ungranted-protected-dispatch (§10.4): protected tool without a grant produces guard=auth_reject', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent({ assignedApp: 'bank' });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('bank_transfer', { to: 'attacker' })] },
      pressure(),
      cfg({ protectedTools: ['bank_transfer'] }),
    );
    expect(action).toMatchObject({ type: 'nudge', guard: 'auth_reject' });
  });

  it('lets open (non-protected) tool calls through as tool_call actions', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent({ assignedApp: 'web' });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('web_search', { query: 'hello' })] },
      pressure(),
      cfg({ protectedTools: ['bank_transfer'] }), // web_search is open
    );
    expect(action.type).toBe('tool_call');
  });

  it('rejects protected tool calls without a grant — guard=auth_reject', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent({ assignedApp: 'bank' });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('bank_transfer', { to: 'attacker' })] },
      pressure(),
      cfg({ protectedTools: ['bank_transfer'] }), // no grant
    );
    expect(action).toMatchObject({ type: 'nudge', guard: 'auth_reject' });
    expect((action as { message: string }).message).toMatch(/protected|authorization|granted/i);
  });

  it('lets a protected tool through when the session holds a grant', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent({ assignedApp: 'bank' });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('bank_transfer', { to: 'alice' })] },
      pressure(),
      cfg({ protectedTools: ['bank_transfer'], grants: ['bank_transfer'] }),
    );
    expect(action.type).toBe('tool_call');
  });

  it('is fully open when no tools are protected', () => {
    const policy = new DefaultAgentPolicy();
    const agent = makeAgent();
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('arbitrary_tool', {})] },
      pressure(),
      cfg(), // empty protectedTools
    );
    expect(action.type).toBe('tool_call');
  });

  it('fires BEFORE dedup guards — duplicate protected call reports auth_reject, not dup', () => {
    const policy = new DefaultAgentPolicy();
    // web_search marked protected + a prior duplicate in history. Without
    // the authGuard running first, the dedup guard would reject with the
    // "already searched" message; the authGuard must win.
    const agent = makeAgent({
      assignedApp: 'web',
      toolHistory: [{ name: 'web_search', args: JSON.stringify({ query: 'foo' }) }],
    });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('web_search', { query: 'foo' })] },
      pressure(),
      cfg({ protectedTools: ['web_search'] }), // no grant
    );
    expect(action).toMatchObject({ type: 'nudge', guard: 'auth_reject' });
  });

  it('terminal tool call still routes to return even with protected tools present', () => {
    const policy = new DefaultAgentPolicy({ minToolCallsBeforeReturn: 0 });
    // The terminal tool is intercepted before _checkGuards, so the
    // authGuard never gates it — agents can always submit findings.
    const agent = makeAgent({ assignedApp: 'web' });
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('report', { result: 'findings' })] },
      pressure(),
      cfg({ protectedTools: ['report', 'bank_transfer'] }),
    );
    expect(action.type).toBe('return');
  });
});

describe('ToolGuard "*" matcher', () => {
  it('a tools: "*" guard sees every tool call', () => {
    const seen: string[] = [];
    const allCallsGuard: ToolGuard = {
      name: 'audit',
      tools: '*',
      reject: (_args, _hist, _agent, toolName) => {
        seen.push(toolName);
        return false;
      },
      message: 'unused',
    };
    const policy = new DefaultAgentPolicy({ extraGuards: [allCallsGuard] });
    const agent = makeAgent();
    policy.onProduced(agent, { content: null, toolCalls: [tc('alpha')] }, pressure(), cfg());
    policy.onProduced(agent, { content: null, toolCalls: [tc('beta')] }, pressure(), cfg());
    expect(seen).toEqual(['alpha', 'beta']);
  });

  it('a tools: "*" guard can read config and reject', () => {
    const policy = new DefaultAgentPolicy({
      extraGuards: [
        {
          name: 'blanket',
          tools: '*',
          reject: (_a, _h, _ag, _name, config) => config.maxTurns > 0,
          message: 'all calls blocked',
        },
      ],
    });
    const agent = makeAgent();
    const action = policy.onProduced(
      agent,
      { content: null, toolCalls: [tc('whatever')] },
      pressure(),
      cfg(), // authGuard is no-op (nothing protected), so the extra guard wins
    );
    expect(action).toMatchObject({
      type: 'nudge',
      guard: 'blanket',
      message: 'all calls blocked',
    });
  });
});
