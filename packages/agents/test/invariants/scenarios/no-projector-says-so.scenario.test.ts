/**
 * Scenario: a tool returns images to a model that cannot see them.
 *
 * The contract is that this is SAID, not silently dropped — an agent that
 * reasons about a picture it was never shown produces confident nonsense, and
 * nothing downstream can tell that is what happened. `_imageError` goes into
 * the result the model reads, mirroring the rate-limit `exhausted` path.
 *
 * Untested until now, which is why it is a scenario rather than an assertion
 * folded into an existing one: the behaviour is load-bearing and the only
 * thing enforcing it was a comment.
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../src/Agent';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { Tool } from '../../../src/Tool';
import { TOOL_IMAGE_ERROR_KEY } from '../../../src/Tool';
import { runPool } from '../harness';
import { MediaTool, PNG_BYTES, MEDIA_TEST_NCTX } from '../../helpers/media';

describe('scenario: a model with no projector is TOLD, not silently shorted', () => {
  const policy: AgentPolicy = {
    onProduced: (_a: Agent, parsed) =>
      parsed.toolCalls.length > 0
        ? { type: 'tool_call', tc: parsed.toolCalls[0] }
        : { type: 'idle', reason: 'free_text_stop' },
    shouldExit: () => false,
  };

  const runBlind = () => runPool({
    nCtx: MEDIA_TEST_NCTX,
    scripts: [{ tokens: [1, 999, 999], toolCall: { name: 'rasterize', arguments: '{}' } }],
    policy,
    tools: new Map<string, Tool>([['rasterize', new MediaTool([PNG_BYTES])]]),
    instrument: (ctx) => { ctx.mockSupportsVision = false; },
  });

  it('puts the reason in the result the model reads', async () => {
    const run = await runBlind();

    const results = run.channelEvents.filter(e => e.type === 'agent:tool_result');
    expect(results.length, 'the tool must still settle a result').toBeGreaterThan(0);
    const body = (results[0] as { result: string }).result;

    expect(body).toContain(TOOL_IMAGE_ERROR_KEY);
    expect(body).toMatch(/cannot see images/i);
  });

  it('never puts the BYTES on the token rail', async () => {
    // The failure this guards is not a missing message but a destroyed
    // prefill: a 180 KB image stringifies to ~700k characters of JSON digits.
    const run = await runBlind();

    const body = (run.channelEvents.find(e => e.type === 'agent:tool_result') as
      { result: string }).result;

    expect(body).not.toContain('_images');
    expect(body.length).toBeLessThan(2_000);
  });

  it('takes the embedding rail for nobody', async () => {
    const run = await runBlind();
    expect(run.nativeCalls.filter(c => c.op === 'prefillMultimodal')).toHaveLength(0);
  });
});
