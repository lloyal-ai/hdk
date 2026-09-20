/**
 * An agent inherits the TEMPLATE's reasoning tag, not the spine's silence.
 *
 * A spine is formatted from a system turn alone. Qwen's template refuses a conversation with
 * no user; liblloyal rescues it by retrying with a synthetic user, and that retry reported the
 * prompt, grammar and parser but none of the reasoning declaration — so the spine's format
 * claimed `supportsThinking: false` with an empty tag, beside a generation prompt that opens a
 * reasoning block. Measured on Qwen3.5-4B, 2026-09-20:
 *
 *   system only + tools : supportsThinking=false  endTag=""          genPrompt="…assistant\n<think>\n"
 *   system + user + tools: supportsThinking=true   endTag="</think>"  genPrompt="…assistant\n<think>\n"
 *
 * Shared-spine mode is the default for a research harness, so every agent inherited the empty
 * tag and the framework's envelope repair silently degraded to stripping the call alone — the
 * exact half-strip that published a bare close to the reader. A mock that hands the tag over
 * directly cannot witness this; this one models a template that declares it only for a
 * conversation it accepts.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import type { FormattedChatResult } from '@lloyal-labs/sdk';
import { createMockSdk } from '../../sdk/src/testing.js';
import type { MockSessionContext } from '../../sdk/src/testing.js';
import { priceSpawn } from '../src/execute';
import { SpineFmt } from '../src/context';
import type { AgentTaskSpec } from '../src/types';
import { fmtWith } from './helpers/format-config';

/** Declares the reasoning tag only for a conversation carrying a user turn. */
function templateRefusingSystemOnly(ctx: MockSessionContext): void {
  const orig = ctx.formatChatSync.bind(ctx);
  ctx.formatChatSync = (msgs: string, opts?: Parameters<typeof orig>[1]): FormattedChatResult => {
    const hasUser = (JSON.parse(msgs) as { role: string }[]).some((m) => m.role === 'user');
    return {
      ...orig(msgs, opts),
      generationPrompt: '<|im_start|>assistant\n<think>\n',
      supportsThinking: hasUser,
      thinkingStartTag: hasUser ? '<think>' : '',
      thinkingEndTag: hasUser ? '</think>' : '',
    };
  };
}

const TASK = { content: 'Task', systemPrompt: 'Agent', seed: 0 } as AgentTaskSpec;

describe('an agent inherits the reasoning tag its template declares', () => {
  it('takes the tag from its own suffix when the shared spine format carries none', async () => {
    const { ctx } = createMockSdk({ nCtx: 8192 });
    templateRefusingSystemOnly(ctx);

    const priced = await run(function* () {
      // What a system-only spine format yields under that template.
      yield* SpineFmt.set(fmtWith({ thinkingEndTag: '', generationPrompt: '<|im_start|>assistant\n<think>\n' }));
      return yield* priceSpawn(TASK, ctx as unknown as Parameters<typeof priceSpawn>[1], true);
    });

    expect(priced.fmt.thinkingEndTag).toBe('</think>');
  });

  it('takes it from its own format outside shared mode too', async () => {
    const { ctx } = createMockSdk({ nCtx: 8192 });
    templateRefusingSystemOnly(ctx);

    const priced = await run(() => priceSpawn(TASK, ctx as unknown as Parameters<typeof priceSpawn>[1], true));

    expect(priced.fmt.thinkingEndTag).toBe('</think>');
  });

  it('stays empty for a template that genuinely does not think', async () => {
    const { ctx } = createMockSdk({ nCtx: 8192 });
    const priced = await run(() => priceSpawn(TASK, ctx as unknown as Parameters<typeof priceSpawn>[1], true));

    expect(priced.fmt.thinkingEndTag).toBe('');
  });
});
