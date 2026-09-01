import type { SessionContext } from './types';

/**
 * The media marker — one per image in a prompt
 *
 * mtmd's literal placeholder: the native tokenizer splits the templated
 * prompt on this marker and replaces each occurrence with that image's
 * encoded rows. Injected as a `media_marker` content part (the chat
 * layer's native part type — never spliced into a content string).
 *
 * @category Agents
 */
export const MEDIA_MARKER = '<__media__>';

/** Defang a literal media marker in model-visible text. The native layer
 *  splits the rendered prompt on EVERY literal occurrence, so text that
 *  happens to contain the marker would desynchronize markers and bitmaps —
 *  more markers than images fails the prefill; an off-by-one mispairs them.
 *  Applied wherever text enters a multimodal prompt. */
const defangMarker = (text: string): string => text.split(MEDIA_MARKER).join('<media>');

/**
 * Chat content carrying one media marker per image
 *
 * The ONE place `media_marker` parts are emitted. Every ingress — a user turn,
 * a spine header, a tool result — renders its text through this, so the marker
 * grammar cannot drift between them.
 *
 * Returns the bare string when there are no images, so a caller can route text
 * and multimodal content through the same expression without branching.
 *
 * Structured parts, never string splicing: `media_marker` is the chat layer's
 * native part type, and the part-joiner owns newline hygiene around markers.
 *
 * @param text - The message text the markers follow
 * @param images - One marker is emitted per entry; bytes are not read here
 *
 * @category Agents
 */
export function mediaContent(
  text: string,
  images: readonly Uint8Array[],
): string | Array<{ type: string; text: string }> {
  if (images.length === 0) return text;
  return [
    { type: 'text', text: defangMarker(text) },
    ...images.map(() => ({ type: 'media_marker', text: MEDIA_MARKER })),
  ];
}

/**
 * A multimodal turn delta — the string-stage counterpart of a token delta
 *
 * Token deltas end at `number[]` because JS owns tokenization on the text
 * path. On the multimodal path mtmd owns tokenization, so the delta stops
 * at the string stage: sep tokens + the templated prompt (markers embedded)
 * + the image bytes, ready for {@link Branch.prefillMultimodal}.
 *
 * @category Agents
 */
export interface MultimodalDelta {
  /** Turn separator tokens (decoded ahead of the prompt) */
  sep: number[];
  /** Templated prompt containing one {@link MEDIA_MARKER} per image */
  prompt: string;
  /** Encoded image bytes in a format the projector decodes, one per marker, in order */
  bitmaps: Uint8Array[];
}

/**
 * Options common to all delta builders.
 *
 * `enableThinking` controls whether the chat template delimits `<think>`
 * blocks. Despite its name, the flag is about template parsing, not about
 * whether the model reasons: many models (Qwen3 family) emit thinking
 * tokens regardless. Setting it `true` gives the template's generation
 * prompt the `<think>\n` prefix those models expect, so their thoughts
 * are correctly delimited and `parseChatOutput` can extract them from
 * visible response. Setting it `false` tells the template to omit think
 * tokens — appropriate when the downstream agent is expected not to think.
 *
 * **Default: undefined** — the delta builder does NOT pass the flag to
 * `formatChatSync`, and the native template chooses (typically `true`).
 * Callers who want `false` must pass it explicitly.
 *
 * This preserves compatibility with thinking-capable models. Hardcoding
 * `false` at the delta-builder layer caused tool-result prefills to corrupt
 * the KV cache for Qwen3-style models: the template omitted the think
 * generation prompt, the model still emitted think tokens, and those
 * tokens leaked into raw output.
 *
 * @category Agents
 */
export interface DeltaOpts {
  enableThinking?: boolean;
}

/**
 * Build a token delta for a user turn
 *
 * Composes `getTurnSeparator()` + `formatChatSync()` + `tokenizeSync()` into a
 * single token array suitable for `branch.prefill()`. Usable with any
 * branch — not tied to {@link Session}'s trunk.
 *
 * This is the canonical way to build a user-turn delta for warm prefill
 * in multi-turn conversations.
 *
 * @param ctx - Active session context
 * @param content - User message content
 * @param opts - Optional tools JSON for tool-aware formatting, an optional
 *   `system` message to lead the turn (default empty), + the thinking flag
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildUserDelta(
  ctx: SessionContext,
  content: string,
  opts: { tools?: string; system?: string } & DeltaOpts = {}
): number[] {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.tools) fmtOpts.tools = opts.tools;
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([{ role: 'system', content: opts.system ?? '' }, { role: 'user', content }]),
    fmtOpts
  );
  const delta = ctx.tokenizeSync(prompt, false);
  return [...sep, ...delta];
}

/**
 * Build a multimodal delta for a user turn with images
 *
 * The multimodal counterpart of {@link buildUserDelta}: same composition,
 * same options, but the user content carries one `media_marker` part per
 * image and the delta stops at the string stage (mtmd owns tokenization —
 * tokenizing the prompt here would double-tokenize).
 *
 * @param ctx - Active session context (created with `mmprojPath`)
 * @param content - User message text
 * @param images - Encoded image bytes, one marker emitted per image
 * @param opts - Same as {@link buildUserDelta}
 * @returns Delta ready for {@link Branch.prefillMultimodal}
 *
 * @category Agents
 */
export function buildUserDeltaMultimodal(
  ctx: SessionContext,
  content: string,
  images: Uint8Array[],
  opts: { tools?: string; system?: string } & DeltaOpts = {}
): MultimodalDelta {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.tools) fmtOpts.tools = opts.tools;
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  // Defanged even with zero images: this delta always lands via the
  // multimodal prefill, whose native splitter sees the whole prompt —
  // system content included.
  const userContent = mediaContent(defangMarker(content), images);
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'system', content: defangMarker(opts.system ?? '') },
      { role: 'user', content: userContent },
    ]),
    fmtOpts
  );
  return { sep, prompt, bitmaps: images };
}

/**
 * Build a token delta for an assistant turn
 *
 * Composes `getTurnSeparator()` + `formatChatSync()` + `tokenizeSync()` into a
 * single token array suitable for `branch.prefill()`. The assistant-side
 * counterpart of {@link buildUserDelta}: writes only an assistant turn into
 * the conversation, no user message, no generation prompt suffix.
 *
 * Used when a half-turn pattern is needed — e.g. the consumer prefilled a
 * user turn earlier (so the planner could attend over it via KV), and now
 * needs to close the pair with the assistant's response without re-emitting
 * the user side.
 *
 * @param ctx - Active session context
 * @param content - Assistant message content
 * @param opts - Optional thinking flag; see {@link DeltaOpts}
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildAssistantDelta(
  ctx: SessionContext,
  content: string,
  opts: DeltaOpts = {}
): number[] {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([{ role: 'system', content: '' }, { role: 'assistant', content }]),
    fmtOpts
  );
  const delta = ctx.tokenizeSync(prompt, false);
  return [...sep, ...delta];
}

/**
 * Build a token delta for a complete user+assistant conversation turn
 *
 * Composes `getTurnSeparator()` + `formatChatSync()` + `tokenizeSync()` into a
 * single token array suitable for `branch.prefill()`. The canonical way to
 * extend any branch (trunk or spine) with a completed turn.
 *
 * Used by {@link Session.commitTurn} to persist query/response to the trunk,
 * and by `PoolContext.extendSpine` in the agent pool to chain per-task
 * findings onto the research spine.
 *
 * @param ctx - Active session context
 * @param userContent - User message content (the question/task)
 * @param assistantContent - Assistant response content (the answer/findings)
 * @param opts - Optional thinking flag; see {@link DeltaOpts}
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildTurnDelta(
  ctx: SessionContext,
  userContent: string,
  assistantContent: string,
  opts: DeltaOpts = {},
): number[] {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ]),
    fmtOpts,
  );
  return [...sep, ...ctx.tokenizeSync(prompt, false)];
}

/**
 * Build a token delta for a tool result turn
 *
 * Composes `getTurnSeparator()` + `formatChatSync()` + `tokenizeSync()` into a
 * single token array suitable for `branch.prefill()`. Used by
 * {@link useAgentPool} to inject tool results back into agent context.
 *
 * For templates that require a user message (e.g. Qwen 3.5), the native layer
 * (`chat_in::format`) retries with a synthetic user and strips it, so the
 * caller always receives correctly formatted output.
 *
 * @param ctx - Active session context
 * @param resultStr - JSON-serialized tool result
 * @param callId - Tool call identifier from the model's parsed output
 * @param opts - Optional thinking flag; see {@link DeltaOpts}
 * @returns Token array ready for `branch.prefill()`
 *
 * @category Agents
 */
export function buildToolResultDelta(
  ctx: SessionContext,
  resultStr: string,
  callId: string,
  opts: DeltaOpts = {},
): number[] {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  const { prompt, generationPrompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'system', content: '' },
      { role: 'tool', content: resultStr, tool_call_id: callId },
    ]),
    fmtOpts,
  );
  const delta = ctx.tokenizeSync(prompt, false);
  // Append generation prompt (e.g. "<|im_start|>assistant\n<think>\n" for thinking models).
  // For non-thinking models this is "<|im_start|>assistant\n" which is already
  // included in prompt by formatChatSync. Tokenizing it again would double it,
  // so only append when it's NOT already a suffix of prompt.
  let genTokens: number[] = [];
  if (generationPrompt && !prompt.endsWith(generationPrompt)) {
    genTokens = ctx.tokenizeSync(generationPrompt, false);
  }
  return [...sep, ...delta, ...genTokens];
}

/**
 * Build a multimodal delta for a tool result carrying images
 *
 * The multimodal counterpart of {@link buildToolResultDelta}: a tool that
 * returns media (a rasterized document page, a rendered chart) has its result
 * text rendered with one marker per image, and the delta stops at the string
 * stage because mtmd owns tokenization.
 *
 * The generation prompt is concatenated onto the prompt STRING rather than
 * tokenized and appended as {@link buildToolResultDelta} does. On the token
 * path the caller owns tokenization and can append ids; here mtmd tokenizes
 * the whole prompt, so anything appended after the fact would never reach it.
 *
 * @param ctx - Active session context (created with `mmprojPath`)
 * @param resultStr - JSON-serialized tool result, with the media stripped out
 * @param callId - Tool call identifier from the model's parsed output
 * @param images - Encoded image bytes, one marker emitted per image
 * @param opts - Optional thinking flag; see {@link DeltaOpts}
 * @returns Delta ready for {@link Branch.prefillMultimodal}
 *
 * @category Agents
 */
export function buildToolResultDeltaMultimodal(
  ctx: SessionContext,
  resultStr: string,
  callId: string,
  images: Uint8Array[],
  opts: DeltaOpts = {},
): MultimodalDelta {
  const sep = ctx.getTurnSeparator();
  const fmtOpts: Record<string, unknown> = {};
  if (opts.enableThinking !== undefined) fmtOpts.enableThinking = opts.enableThinking;
  const { prompt, generationPrompt } = ctx.formatChatSync(
    JSON.stringify([
      { role: 'system', content: '' },
      { role: 'tool', content: mediaContent(defangMarker(resultStr), images), tool_call_id: callId },
    ]),
    fmtOpts,
  );
  const withGen =
    generationPrompt && !prompt.endsWith(generationPrompt)
      ? prompt + generationPrompt
      : prompt;
  return { sep, prompt: withGen, bitmaps: images };
}

/**
 * KV cells a multimodal delta will consume, measured before it decodes
 *
 * The admission cost. `decode_segments` is not atomic, so a caller that
 * discovers the overflow midway has poisoned the branch and must prune it;
 * one that refuses up front has spent nothing. Text can be measured by
 * tokenizing it — the token path gets its count for free from
 * `prefillTokens.length` — but an image cannot, because the caller holds bytes
 * and the row count depends on the projector's geometry. Without this, media
 * is the one input that reaches KV ungated.
 *
 * Deliberately NOT computed inside the delta builders: they are pure
 * `formatChatSync` composition, and this does native work (bitmap decode plus
 * tokenization). Measuring where a cost is actually needed keeps that work off
 * every caller that only wants to build a delta.
 *
 * Cells, not positions or tokens: a KV budget is spent in cells, and under
 * M-RoPE an image costs far more cells than it advances position. The number
 * is directly comparable with `ContextPressure.headroom` and with the
 * `tokensDecoded` the prefill reports back.
 *
 * @param ctx - Active session context (created with `mmprojPath`)
 * @param delta - Built by any of the multimodal delta builders
 * @returns Cells the prefill would add — sep + text + image rows
 *
 * @category Agents
 */
export async function deltaCells(
  ctx: SessionContext,
  delta: MultimodalDelta,
): Promise<number> {
  return ctx._cellsMultimodal(delta.sep, delta.prompt, delta.bitmaps);
}
