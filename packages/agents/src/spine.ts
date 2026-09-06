
import type { Operation } from "effection";
import { prefillBranch, prefillBranchMultimodal } from "./execute";
import { Branch, mediaContent } from "@lloyal-labs/sdk";
import type { SessionContext } from "@lloyal-labs/sdk";
import { Ctx, Trace, TraceParent, SpineFmt, Attachments, Ingress } from "./context";
import type { Attachment } from "@lloyal-labs/media";
import { prepareBatch } from "./prepare-content";
import { useTraceScope } from "./trace-scope";
import { createToolkit } from "./toolkit";
import type { Tool } from "./Tool";
import type { SamplingParams } from "./types";
import type { FormatConfig } from "./Agent";

/**
 * Configuration for {@link withSpine}
 *
 * @category Agents
 */
export interface SpineOptions {
  /** Sampling parameters for the spine branch */
  params?: SamplingParams;
  /**
   * Fork the spine from this branch instead of creating at position 0.
   *
   * When provided, the spine inherits the parent's full KV state —
   * every tool call, tool result, and generated token the parent
   * accumulated. Sub-agents forking from this spine attend over the
   * parent's complete attention state (Continuous Context).
   *
   * When omitted, creates a fresh spine at position 0 (cold start).
   */
  parent?: Branch;
  /**
   * When set, prefill the chat-format `[system + tools]` header onto the
   * spine once at setup. Every agent forking from the spine inherits these
   * tokens via `forkSync`'s metadata-only KV prefix-share — the role and
   * tool schemas appear ONCE in physical KV regardless of how many agents
   * the pool spawns.
   *
   * The resulting `FormatConfig` (parser/grammar/format/triggers) is set
   * on the {@link SpineFmt} context so `setupAgent` can detect shared mode,
   * skip its own system+tools formatting, and inherit the dispatch-side
   * fmt from the spine.
   *
   * Use this for orchestrators where every agent shares the same role —
   * chain-mode research pools, fanout-style same-role pools, etc. Mixed-
   * role workflows (research → compare → synthesize) keep using per-spec
   * `SpawnSpec.systemPrompt` and don't pass this option.
   */
  systemPrompt?: string;
  /**
   * Tools whose schemas embed into the chat-format header prefilled at setup.
   * Their JSON schemas are decoded into the spine's KV ONCE; every agent
   * forking from the spine inherits the schema tokens via fork prefix-share
   * instead of re-emitting them in its own suffix.
   *
   * The same `Tool[]` is typically also passed to `agentPool` (where it
   * becomes the dispatcher registry). Two roles, one input — schemas
   * decoded once into the spine, instances registered for runtime
   * `tool.execute()` dispatch.
   *
   * Only applied when `systemPrompt` is also set (shared mode); ignored
   * otherwise.
   */
  tools?: Tool[];
  /**
   * Whether to enable thinking-mode tokens (e.g. `<think>` blocks) when
   * formatting the spine's chat-format header. Threaded through to the
   * chat-format call AND stored on the `SpineFmt` FormatConfig so
   * `setupAgent`'s shared-mode shortcut copies a parser/grammar/triggers
   * configuration consistent with the per-agent suffix formatting.
   *
   * Should match the `enableThinking` value the caller passes to the agent
   * pool — divergent values produce inconsistent grammar between the
   * prefilled spine and per-agent suffixes.
   *
   * @default true
   */
  enableThinking?: boolean;
  /**
   * Images prefilled into the spine's chat-format header at setup — the
   * shared reference the whole pool attends. One media marker is emitted
   * into the system content per image; the header decodes ONCE (text on
   * the token rail, image rows on the embedding rail) and every agent
   * forking from the spine inherits the images via fork prefix-share —
   * encoded exactly once, zero re-encode per agent.
   *
   * Requires a context created with `mmprojPath`. Like `tools`, only
   * applied when `systemPrompt` is also set (shared mode); ignored
   * otherwise.
   */
  bitmaps?: Uint8Array[];
}

/**
 * Scoped spine branch with guaranteed cleanup
 *
 * Creates (or forks) the pool's spine — the shared KV line that agents
 * fork from and that `ctx.extendSpine` writes onto between tasks. The
 * spine is pruned via try/finally when the body returns or throws,
 * regardless of whether children still exist.
 *
 * Each agent's chat format (system + user + generation prompt) is rendered
 * fresh inside `setupAgent`, so this spine carries no chat context itself —
 * it exists as the pool's branching point and as the line that
 * `ctx.extendSpine` writes onto between tasks.
 *
 * **Cold path** (no `parent`): creates a spine at position 0 with no prefill.
 * Agents fork at position 0; their full chat context lives in their own suffix.
 *
 * **Warm path** (`parent` provided): forks from parent and prefills a turn
 * separator so subsequent agent suffixes land on a clean turn boundary.
 * Sub-agents inherit the parent's full KV state via the fork.
 *
 * @param opts - Sampling parameters and optional parent branch
 * @param body - Operation that receives the spine branch and prefix length.
 *   Typically calls {@link useAgentPool} inside.
 * @returns The body's return value
 *
 * @category Agents
 */
export function* withSpine<T>(
  opts: SpineOptions,
  body: (spine: Branch, prefixLength: number) => Operation<T>,
): Operation<T> {
  const ctx: SessionContext = yield* Ctx.expect();
  const tw = yield* Trace.expect();
  const attachments = yield* Attachments.expect();
  const ingress = yield* Ingress.expect();

  // Read parent trace ID — connects nested pools to the outer DISPATCH that spawned them
  let parentTraceId: number | null = null;
  try {
    const p = yield* TraceParent.get();
    if (p != null) parentTraceId = p;
  } catch {
    /* no parent — top level */
  }

  const scopeId = yield* useTraceScope(tw, parentTraceId, "withSpine", {
    hasParent: !!opts.parent,
  });

  // Warm path: fork from parent branch (inherits full KV state), prefill a
  // turn separator so the next agent's suffix lands on a clean boundary.
  // Cold path: create fresh spine at position 0 with no prefill — agents
  // fork at 0 and carry their full chat context in their own suffix.
  let spine: Branch;
  let prefillTokens: number[];

  if (opts.parent) {
    spine = opts.parent.forkSync();
    prefillTokens = ctx.getTurnSeparator();
  } else {
    spine = Branch.create(ctx, 0, opts.params ?? { temperature: 0.5 });
    prefillTokens = [];
  }

  tw.write({
    traceId: tw.nextId(),
    parentTraceId: scopeId,
    ts: performance.now(),
    type: "branch:create",
    branchHandle: spine.handle,
    parentHandle: opts.parent?.handle ?? null,
    position: opts.parent ? opts.parent.position : 0,
    role: "spine",
  });

  // From here the branch exists: every step — header prefill, the media
  // barrier, the multimodal prefill — runs INSIDE the scope that prunes it,
  // so a failure on any of them cannot leak a slot or a poisoned branch.
  try {
    if (prefillTokens.length > 0) {
      yield* prefillBranch(spine, prefillTokens);
      tw.write({
        traceId: tw.nextId(),
        parentTraceId: scopeId,
        ts: performance.now(),
        type: "branch:prefill",
        branchHandle: spine.handle,
        cells: prefillTokens.length,
        role: "spineHeader",
      });
    }

    // Shared role+tools mode: format the chat header once and prefill onto
    // the spine. Agents forking from this spine inherit system+tools tokens
    // via metadata-only prefix-share (no per-spawn re-prefill). The resulting
    // FormatConfig is stashed on SpineFmt so setupAgent can detect shared
    // mode and copy parser/grammar/format/triggers without re-emitting the
    // tool schemas in each agent's suffix.
    let spineFmt: FormatConfig | null = null;
    if (opts.systemPrompt !== undefined) {
      const enableThinking = opts.enableThinking ?? true;

      // THE BARRIER. Every image is normalized and committed BEFORE a single
      // marker is emitted or any KV is touched, so a failure on image N leaves
      // no markers, no prefill and no published descriptors — only unreachable
      // content-addressed blobs, which are harmless. `bitmaps` below is what the
      // projector will actually decode: the admitted representations, not the
      // raw input, because those are the bytes whose cells replay must rebuild.
      const raw = opts.bitmaps ?? [];
      const prepared = raw.length > 0
        ? yield* prepareBatch(ingress, attachments, raw)
        : { attachments: [], bitmaps: [] };
      const bitmaps = prepared.bitmaps as Uint8Array[];
      // Marker injection goes through the SDK's `mediaContent` — the one place
      // media_marker parts are emitted — so the spine header, a user turn and a
      // tool result cannot drift apart in how they mark media. It returns the
      // bare string when there are no bitmaps, which is the text-path shape.
      //
      // The spine does not use a delta builder: it needs the whole
      // FormattedChatResult for `spineFmt` (grammar/format/parser/triggers) and
      // the messages JSON for the trace seed, neither of which a
      // `MultimodalDelta` carries. Sharing the marker grammar is the part that
      // matters; the rest of this assembly is legitimately spine-specific.
      const messages = JSON.stringify([
        { role: "system", content: mediaContent(opts.systemPrompt, bitmaps) },
      ]);
      const fmtOpts: Record<string, unknown> = {
        enableThinking,
        // Header ends at <|im_end|>; agents append <|im_start|>user…assistant
        // markers as their suffix. Without this, the template would emit a
        // trailing assistant generation prompt and corrupt the boundary.
        addGenerationPrompt: false,
      };
      if (opts.tools && opts.tools.length > 0) {
        fmtOpts.tools = createToolkit(opts.tools).toolsJson;
      }
      const formatted = ctx.formatChatSync(messages, fmtOpts);
      // Spine-seed emission for trace replay (`extractSpineSeed`). Captures
      // the rendered chat prompt verbatim so a later `reconstructBranch`
      // can rebuild this exact KV state in a fresh context.
      //
      // WRITE-AHEAD, on BOTH rails: the seed says what this spine INTENDS to
      // prefill, so a prefill that then fails still leaves a run that can be
      // rebuilt — and a failed multimodal prefill poisons the branch, which is
      // exactly when replay is the only way back. `branch:prefill` below is the
      // other half of the pair and asserts the opposite: it is written only
      // after the KV actually moved.
      //
      // `tokenCount` is omitted on the embedding rail — mtmd owns tokenization
      // there and no honest count exists before the native call returns. The
      // count that landed rides `branch:prefill`.
      const writeSpineSeed = (tokenCount?: number): void => {
        tw.write({
          traceId: tw.nextId(),
          parentTraceId: scopeId,
          ts: performance.now(),
          type: "prompt:format",
          promptText: formatted.prompt,
          tokenCount,
          // Roots ride the seed WRITE-AHEAD: the barrier committed the content
          // before any prefill, so a failed multimodal prefill still leaves a
          // seed that replay can rebuild from. `branch:prefill` below keeps
          // the success-only copy.
          ...(prepared.attachments.length > 0
            ? { attachments: prepared.attachments }
            : {}),
          messages,
          tools: opts.tools && opts.tools.length > 0
            ? createToolkit(opts.tools).toolsJson
            : undefined,
          role: "spine",
        });
      };

      let headerCells = 0;
      let attached: readonly Attachment[] | undefined;
      if (bitmaps.length > 0) {
        writeSpineSeed();
        const counts = yield* prefillBranchMultimodal(spine, formatted.prompt, bitmaps);
        headerCells = counts.tokensDecoded;
        // Already committed by the barrier above — this only carries the roots
        // onto the trace. Recording used to happen HERE, after the prefill, so
        // a failed write left media in the cache that could never be replayed.
        attached = prepared.attachments;
      } else {
        const headerTokens = ctx.tokenizeSync(formatted.prompt, false);
        writeSpineSeed(headerTokens.length);
        headerCells = headerTokens.length;
        if (headerTokens.length > 0) {
          yield* prefillBranch(spine, headerTokens);
        }
      }
      if (headerCells > 0) {
        tw.write({
          traceId: tw.nextId(),
          parentTraceId: scopeId,
          ts: performance.now(),
          type: "branch:prefill",
          branchHandle: spine.handle,
          cells: headerCells,
          role: "spineHeader",
          ...(attached ? { attachments: attached } : {}),
        });
      }
      spineFmt = {
        format: formatted.format,
        reasoningFormat: formatted.reasoningFormat,
        generationPrompt: formatted.generationPrompt,
        parser: formatted.parser,
        grammar: formatted.grammar,
        grammarLazy: formatted.grammarLazy,
        grammarTriggers: formatted.grammarTriggers,
        enableThinking,
      };
    }
    if (spineFmt) yield* SpineFmt.set(spineFmt);
    return yield* body(spine, prefillTokens.length);
  } finally {
    if (!spine.disposed) {
      tw.write({
        traceId: tw.nextId(),
        parentTraceId: scopeId,
        ts: performance.now(),
        type: "branch:prune",
        branchHandle: spine.handle,
        position: 0,
      });
      spine.pruneSubtreeSync();
    }
  }
}
