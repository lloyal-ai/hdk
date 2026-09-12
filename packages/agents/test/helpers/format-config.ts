import type { FormatConfig } from '../../src/Agent';

/**
 * A neutral `FormatConfig` for tests that need one but do not care about it.
 *
 * One fixture rather than four: this literal was copied into `Agent.test.ts`,
 * `AgentPolicy.test.ts`, `authGuard.test.ts` and `spawn-agents.test.ts`, and
 * when `enableThinking` became required every copy drifted at once —
 * invisibly, because no tsc project covered the tests. Typed as `FormatConfig`
 * so the next added field fails HERE, once, instead of in four places or
 * nowhere.
 *
 * `enableThinking: false` matches the agent-side default: an agent that has not
 * opted in must not have `<think>` prefill assumed, or the parser's
 * `generation_prompt` diverges from actual KV state.
 */
export const FMT: FormatConfig = {
  format: 0,
  reasoningFormat: 0,
  generationPrompt: '',
  parser: '',
  grammar: '',
  grammarLazy: false,
  grammarTriggers: [],
  enableThinking: false,
};

/** The same fixture with fields overridden — for the few tests that vary one. */
export const fmtWith = (over: Partial<FormatConfig>): FormatConfig => ({ ...FMT, ...over });
