/**
 * Scenario: one entry of a media cohort fails natively, and the trace says so.
 *
 * `branch:prefill` is the event that asserts the KV CHANGED — replay and the
 * dev panes both read it that way. SETTLE used to write it inside the
 * admission loop, before either dispatch had run, so a poisoned entry left an
 * event claiming cells that never landed. The sibling that DID land needs its
 * event just as much, which is why this asserts both halves.
 *
 * The failure is native (`mockMultimodalError`), not an ingress refusal: the
 * bytes were normalized and committed, admission passed, and `decode_segments`
 * failed anyway — the one path where a branch is POISONED rather than merely
 * unchanged.
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../src/Agent';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { Tool } from '../../../src/Tool';
import { runPool } from '../harness';
import { I33_agentFailureIsIsolated, formatResult } from '../predicates';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX, mediaFailures } from '../../helpers/media';

describe('scenario: a poisoned media prefill claims no KV', () => {
  const policy: AgentPolicy = {
    onProduced: (_a: Agent, parsed) =>
      parsed.toolCalls.length > 0
        ? { type: 'tool_call', tc: parsed.toolCalls[0] }
        : { type: 'idle', reason: 'free_text_stop' },
    shouldExit: () => false,
  };

  /** Two agents settle media in one cohort; the FIRST entry fails natively. */
  const runOneFailing = () => runPool({
    nCtx: MEDIA_TEST_NCTX,
    scripts: [
      { tokens: [1, 999, 999], toolCall: { name: 'rasterize', arguments: '{}' } },
      { tokens: [1, 999, 999], toolCall: { name: 'rasterize', arguments: '{}' } },
    ],
    policy,
    tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
    instrument: (ctx) => {
      let seen = 0;
      ctx.mockMultimodalError = () =>
        seen++ === 0 ? 'decode_segments failed on image 0' : null;
    },
  });

  it('records exactly the entries that landed', async () => {
    const run = await runOneFailing();

    const failed = mediaFailures(run.channelEvents)
      .map(e => (e as { agentId: number }).agentId);
    expect(failed, 'expected exactly one media-rail failure').toHaveLength(1);

    // Agents settle repeatedly (the policy never exits), so this counts WHOSE
    // prefills were recorded, not how many. The poisoned agent must appear in
    // none of them; its sibling must appear.
    const claimed = new Set(run.traceEvents
      .filter(e => e.type === 'branch:prefill' && e.role === 'toolResult')
      .map(e => (e as { branchHandle: number }).branchHandle));

    expect(claimed.has(failed[0]),
      'the poisoned agent must leave no event claiming its cells landed').toBe(false);
    expect(claimed.size, 'the surviving agent must still be recorded')
      .toBeGreaterThan(0);
  });

  it('is not recorded as a RECOVERY failure', async () => {
    // `pool:recoveryFailed` has a stated meaning — "produce completed but
    // output unparseable", emitted by recoverInline — and `outputExcerpt` is
    // the MODEL'S output. A native decode error is neither. Overloading the
    // event makes the field's own invariant false and leaves a reader unable
    // to tell an unparseable answer from a failed prefill without matching on
    // `reason`.
    const run = await runOneFailing();
    const victim = (mediaFailures(run.channelEvents)[0] as { agentId: number }).agentId;

    // Scoped to the POISONED agent. The surviving sibling legitimately reaches
    // the termination sweep and can fail a real recovery there — a pool-wide
    // count would have been asserting on that instead.
    expect(run.traceEvents.filter(
      e => e.type === 'pool:recoveryFailed' && (e as { agentId: number }).agentId === victim),
      'no recovery ran for this agent, so nothing may claim one failed').toHaveLength(0);

    const settle = run.traceEvents.filter(e => e.type === 'pool:settleFailed');
    expect(settle, 'the admission failure needs an event of its own').toHaveLength(1);
    expect((settle[0] as { reason: string }).reason).toBe('media_prefill_failed');
    expect((settle[0] as { detail: string }).detail).toMatch(/decode_segments/);
  });

  it('fails only that agent', async () => {
    const run = await runOneFailing();
    const r = I33_agentFailureIsIsolated(run, 'media_prefill_failed');
    expect(r.ok, formatResult('I33', r)).toBe(true);
  });
});
