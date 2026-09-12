/**
 * The frame's authorization gate, at the pool: no policy shape can skip it.
 *
 * The frame's walk itself is tested as pure functions in `hooks.test.ts`; the
 * B0 baseline pins grants under the default policy, authorization beating a
 * tool's own gate, and `useAgent`. Every policy HERE is a literal — none is a
 * `DefaultAgentPolicy` — so what this file locks is the pool's wiring:
 *
 * 1. **Open tools pass through.** A non-protected tool executes regardless of grants.
 * 2. **Protected without a grant is refused, observably.** `tool:authReject`
 *    names the attempted tool, the agent books a `nudge` in the call's place,
 *    `execute` never runs, and the model reads the canonical message.
 * 3. **Protected WITH a grant executes.** Trust changes privileges, not behaviour.
 * 4. **Nothing protected = fully open.**
 * 5. **The terminal tool is not gated.** A protected terminal still returns.
 * 6. **`guardOverrides` cannot switch the gate off.** `{ auth_reject: false }` is inert.
 * 7. **A call the policy did not take from the model is gated at dispatch.**
 *    A policy that makes up a protected call when the model emitted none, or
 *    renames the emitted call in place, is refused under the dispatched name
 *    and nothing executes.
 *
 * Together these lock the M2 invariant (RFC §3.2 / §5.3c): dispatch-time
 * protected-tool rejection is OBSERVABLE (`tool:authReject`) and STRICT
 * (fail-closed, whatever the policy).
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import type { ParsedToolCall } from '@lloyal-labs/sdk';
import type { Tool } from '../src/Tool';
import { runPool } from './invariants/harness';
import {
  OpenTool, ProtectedTool, parse, literalPolicy, FIRST, nudges, dispatches, authRejects, outcomesOf,
} from './helpers/lifecycle';

const AUTH_MESSAGE = /protected|authorization|granted/i;
const bank = { name: 'bank', arguments: JSON.stringify({ to: 'attacker' }) };
const web = { name: 'web', arguments: JSON.stringify({ query: 'hello' }) };

describe('authorization at the pool (literal policies)', () => {
  it('P-no-ungranted-protected-dispatch (§10.4): a protected tool without a grant is refused, observably', async () => {
    const tool = new ProtectedTool('bank');
    const r = await runPool({
      scripts: [{ tokens: FIRST }], policy: literalPolicy(), tools: new Map<string, Tool>([['bank', tool]]),
      trace: true, instrument: parse({ t1: bank }),
    });
    expect(tool.calls).toHaveLength(0);
    expect(dispatches(r)).toHaveLength(0);
    expect(authRejects(r).map((e) => e.attemptedTool)).toEqual(['bank']);
    const n = nudges(r);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ guard: 'auth_reject', tool: 'bank' });
    expect(n[0].message).toMatch(AUTH_MESSAGE);
    expect(outcomesOf(r, 0, 'bank')).toEqual(['nudge']);
  });

  it('lets an open tool through while another is protected', async () => {
    const open = new OpenTool('web');
    const protectedTool = new ProtectedTool('bank');
    const r = await runPool({
      scripts: [{ tokens: FIRST }], policy: literalPolicy(),
      tools: new Map<string, Tool>([['web', open], ['bank', protectedTool]]),
      trace: true, instrument: parse({ t1: web }),
    });
    expect(open.calls).toEqual([{ query: 'hello' }]);
    expect(authRejects(r)).toHaveLength(0);
    expect(outcomesOf(r, 0, 'web')).toEqual(['toolResult']);
  });

  it('executes a protected tool when the session holds the grant', async () => {
    const tool = new ProtectedTool('bank');
    const r = await runPool({
      scripts: [{ tokens: FIRST }], policy: literalPolicy(), tools: new Map<string, Tool>([['bank', tool]]),
      trace: true, grants: ['bank'], instrument: parse({ t1: bank }),
    });
    expect(tool.calls).toEqual([{ to: 'attacker' }]);
    expect(authRejects(r)).toHaveLength(0);
    expect(outcomesOf(r, 0, 'bank')).toEqual(['toolResult']);
  });

  it('is fully open when nothing is protected', async () => {
    const tool = new OpenTool('bank');
    const r = await runPool({
      scripts: [{ tokens: FIRST }], policy: literalPolicy(), tools: new Map<string, Tool>([['bank', tool]]),
      trace: true, instrument: parse({ t1: bank }),
    });
    expect(tool.calls).toHaveLength(1);
    expect(authRejects(r)).toHaveLength(0);
  });

  it('does not gate the terminal tool: a protected terminal still returns', async () => {
    const report = new ProtectedTool('report');
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: literalPolicy({
        onProduced: (_a, parsed) => {
          const tc = parsed.toolCalls[0];
          if (tc?.name === 'report') return { type: 'return', result: JSON.parse(tc.arguments).result };
          return tc ? { type: 'tool_call', tc } : { type: 'idle', reason: 'free_text_stop' };
        },
      }),
      tools: new Map<string, Tool>([['report', report]]),
      terminalToolName: 'report', trace: true,
      instrument: parse({ t1: { name: 'report', arguments: JSON.stringify({ result: 'findings' }) } }),
    });
    expect(report.calls).toHaveLength(0);
    expect(authRejects(r)).toHaveLength(0);
    const returns = r.channelEvents.filter((e) => e.type === 'agent:return') as Array<{ result: string }>;
    expect(returns.map((e) => e.result)).toEqual(['findings']);
  });

  it('cannot be switched off by name: guardOverrides { auth_reject: false } is inert', async () => {
    const tool = new ProtectedTool('bank');
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: literalPolicy({ guardOverrides: { auth_reject: false } }),
      tools: new Map<string, Tool>([['bank', tool]]),
      trace: true, instrument: parse({ t1: bank }),
    });
    expect(tool.calls).toHaveLength(0);
    expect(authRejects(r).map((e) => e.attemptedTool)).toEqual(['bank']);
    expect(nudges(r).map((n) => n.guard)).toEqual(['auth_reject']);
  });

  it('gates a call the policy made up when the model emitted none', async () => {
    const tool = new ProtectedTool('bank');
    let made = false;
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: literalPolicy({
        onProduced: () => {
          if (made) return { type: 'idle', reason: 'free_text_stop' };
          made = true;
          return { type: 'tool_call', tc: { ...bank, id: 'made-up' } };
        },
      }),
      tools: new Map<string, Tool>([['bank', tool]]),
      trace: true, instrument: parse({}),
    });
    expect(tool.calls).toHaveLength(0);
    expect(dispatches(r)).toHaveLength(0);
    expect(authRejects(r).map((e) => e.attemptedTool)).toEqual(['bank']);
    expect(nudges(r)[0]).toMatchObject({ guard: 'auth_reject', tool: 'bank' });
    expect(r.error).toBeUndefined();
  });

  it('gates a call the policy renamed in place: the dispatched name is what is refused', async () => {
    const open = new OpenTool('web');
    const protectedTool = new ProtectedTool('bank');
    const r = await runPool({
      scripts: [{ tokens: FIRST }],
      policy: literalPolicy({
        onProduced: (_a, parsed) => {
          const tc = parsed.toolCalls[0] as ParsedToolCall | undefined;
          if (!tc) return { type: 'idle', reason: 'free_text_stop' };
          tc.name = 'bank';   // the object the gate already passed, mutated after the fact
          return { type: 'tool_call', tc };
        },
      }),
      tools: new Map<string, Tool>([['web', open], ['bank', protectedTool]]),
      trace: true, instrument: parse({ t1: web }),
    });
    expect(open.calls).toHaveLength(0);
    expect(protectedTool.calls).toHaveLength(0);
    expect(dispatches(r)).toHaveLength(0);
    expect(authRejects(r).map((e) => e.attemptedTool)).toEqual(['bank']);
    expect(outcomesOf(r, 0, 'bank')).toEqual(['nudge']);
  });
});
