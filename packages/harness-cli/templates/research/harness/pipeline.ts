/**
 * Harness — pipeline that turns a user query into an answer.
 *
 * Two public Operations:
 *
 *   runQuery(query, ...)          — runs the planner, dispatches on intent.
 *                                    Handles passthrough internally; returns
 *                                    a research plan for callers to route
 *                                    (plan-review dialog or direct execution).
 *
 *   runResearchPlan(query, plan,..) — runs research → maybe-synth → finalize
 *                                    for an already-vetted plan. Used by the
 *                                    accept_plan path (after plan-review) and
 *                                    by the START path (synthetic 1-task plan
 *                                    bypassing the planner).
 *
 * Two structural gates encode invariants, not user-mode flags:
 *
 *   1. session.trunk gates the passthrough fast-path. Without a warm trunk
 *      there's nothing to fork from; the pipeline falls through to research
 *      transparently. This is what makes first-query START work without any
 *      special-case — START produces a research plan, falls into Stage 4.
 *
 *   2. plan.tasks.length > 1 gates synth. Synth aggregates findings across
 *      multiple agents into one argument. With a single agent there's
 *      nothing to aggregate — that agent's report IS the answer. The synth
 *      prompts also assume multi-agent framing ("findings from N parallel
 *      research agents"), so running synth on a single source produces
 *      awkward output.
 */

import { call, resource, createContext } from "effection";
import type { Operation } from "effection";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORT_PRESETS, type Effort } from "./effort-presets.js";
import type { Session, SessionContext } from "@lloyal-labs/sdk";
import {
  Ctx,
  Events,
  AppRegistryCtx,
  agentPool,
  useAgent,
  chain,
  parallel,
  renderTemplate,
  withSpine,
  DefaultAgentPolicy,
  ContextPressure,
} from "@lloyal-labs/lloyal-agents";
import type { AgentEvent, App, AgentRenderCtx, Agent, DefaultAgentPolicyOpts } from "@lloyal-labs/lloyal-agents";
import type { StepEvent } from "./protocol.js";
import type { OpTiming } from "./state.js";
import {
  reportTool,
  ReportTool,
  PlanTool,
  renderSpine,
  renderAgentPreamble,
} from "@lloyal-labs/rig";
import type { PlanResult, ResearchTask } from "@lloyal-labs/rig";
import { taskToContent } from "@lloyal-labs/rig";
import { weaveSourcesIntoResult } from "./weave-sources.js";

// ── Prompts ─────────────────────────────────────────────────────
//
// The .eta sources are inlined into the bundle as string constants by
// esbuild's `--loader:.eta=text` AT BUILD TIME, so the running bundle
// reads no prompt files. Every placement bundles this harness — the CLI
// (dist/bundle.mjs), a host that forks that bin, an in-process
// model-runtime host — so it is always esbuilt, never executed as raw
// TS: `eta.d.ts` is a TYPE-only shim (it satisfies tsc but provides no
// runtime loader). The sources themselves DO ship (src/prompts/*.eta,
// via the `files` whitelist that also carries the ./protocol/./state
// source exports) — they're just carried inlined, not read from disk.

import PREFLIGHT_RAW from "../prompts/preflight.eta";
import PREFLIGHT_RECOVER_RAW from "../prompts/preflight-recover.eta";
import PLAN_RAW from "../prompts/plan.eta";
import PLAN_FLAT_RAW from "../prompts/plan-flat.eta";
import RECOVERY_RAW from "../prompts/recovery.eta";
import SYNTHESIZE_RAW from "../prompts/synthesize.eta";
import SYNTHESIZE_FLAT_RAW from "../prompts/synthesize-flat.eta";

function parsePrompt(raw: string): { system: string; user: string } {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf("\n---\n");
  if (sep === -1) return { system: trimmed, user: "" };
  return {
    system: trimmed.slice(0, sep).trim(),
    user: trimmed.slice(sep + 5).trim(),
  };
}

/**
 * The 7 baked prompts, keyed by override name. A project overrides any one by
 * dropping `prompts/<name>.eta` into its tree (see {@link PromptsCtx} +
 * {@link resolvePrompt}); an absent override dir uses these RACE/DRB-tuned
 * defaults with ZERO disk I/O — trace-parity: an empty `prompts/` ≡ today.
 */
const BAKED = {
  preflight: PREFLIGHT_RAW,
  "preflight-recover": PREFLIGHT_RECOVER_RAW,
  plan: PLAN_RAW,
  "plan-flat": PLAN_FLAT_RAW,
  recovery: RECOVERY_RAW,
  synthesize: SYNTHESIZE_RAW,
  "synthesize-flat": SYNTHESIZE_FLAT_RAW,
} as const satisfies Record<string, string>;

export type PromptName = keyof typeof BAKED;

type Prompt = { system: string; user: string };

/**
 * The project's prompt-override directory, or null (baked defaults only). Set
 * once per boot by the runner (`runMain`/`runServedSession`) to the project's
 * `prompts/` dir — but ONLY when it exists, so the default (no dir) is truly
 * zero-I/O. Mirrors {@link CoverageCacheCtx}. Default null → `.get()` returns
 * null when unset → the baked path.
 */
export const PromptsCtx = createContext<string | null>("reasoning.promptsDir", null);

const promptMemo = new Map<string, Prompt>();

/**
 * Resolve a prompt by name: `<promptsDir>/<name>.eta` if present, else the baked
 * default. Memoized per `(dir,name)` — a present override reads disk at most
 * once; the baked path never touches disk. `PromptsCtx` unset (the default) ⇒
 * baked, no I/O.
 */
export function* resolvePrompt(name: PromptName): Operation<Prompt> {
  const dir = (yield* PromptsCtx.get()) ?? null;
  const key = `${dir ?? ""}\u0000${name}`;
  const hit = promptMemo.get(key);
  if (hit) return hit;
  let raw: string = BAKED[name];
  if (dir) {
    const file = join(dir, `${name}.eta`);
    if (existsSync(file)) raw = readFileSync(file, "utf8");
  }
  const parsed = parsePrompt(raw);
  promptMemo.set(key, parsed);
  return parsed;
}

// Run-effort type + presets live in `./effort-presets` (shared, dep-free) so the
// Settings UI can display the same policy values the harness applies here.
export type { Effort } from "./effort-presets.js";

/**
 * The research pool's terminal `report` tool, extended with a grammar-forced
 * structured `sources: [{title, url}]` field via rig's `ReportTool` schema seam
 * (`extraProperties`/`extraRequired`). The pool captures only the `result` string;
 * {@link SourceWeavingPolicy} reads the sibling `sources` off the same call and
 * weaves them inline at capture (see {@link weaveSourcesIntoResult}). Recon keeps
 * rig's plain `reportTool` — its coverage output isn't cited.
 */
const citedReportTool = new ReportTool({
  description:
    "Submit your final research findings with specific evidence, direct quotes, and data points. Cite each claim inline as [title](url) using the exact URL seen in tool results. Fill the sources field with the structured list of every source you used. State what you found AND what you checked but could not find. Do not summarize — preserve detail.",
  resultDescription:
    "Detailed findings with direct quotes and data points. Cite each claim inline as [title](url) using the exact URL seen in tool results. Include what was found and what was not found.",
  extraProperties: {
    sources: {
      type: "array",
      description:
        "Every source you used: exact title and exact URL as seen in tool results. Empty array only if no URL sources exist.",
      items: {
        type: "object",
        properties: { title: { type: "string" }, url: { type: "string" } },
        required: ["title", "url"],
      },
    },
  },
  extraRequired: ["sources"],
});

/**
 * Research policy for a run effort + reasoning mode. `high` reproduces the
 * historical budget exactly. Parallel recovery is a flat-mode + low-effort
 * concern (a small cohort folded fast); everything else staggers — and the
 * WindDown drain forces the fold regardless of this default.
 */
function createResearchPolicy(
  effort: Effort,
  mode: "flat" | "deep",
  isAsk = false,
  recoveryPrompt: Prompt,
): DefaultAgentPolicy {
  const preset = EFFORT_PRESETS[effort];
  const opts: DefaultAgentPolicyOpts = {
    budget: preset.budget,
    // Ask also salvages an involuntarily-dropped agent (pressure/time before it answers)
    // instead of skipping it below the 2-tool/100-token floor — its work shouldn't be lost.
    recovery: isAsk
      ? { prompt: recoveryPrompt, minToolCalls: 0, minTokens: 0 }
      : { prompt: recoveryPrompt },
    terminalToolName: "report",
    // low AND medium bin-pack recovery in-loop (parallel); high stays staggered
    // (serial, full-headroom, lossless). Deep is always staggered.
    recoveryShape:
      mode === "flat" && effort !== "high" ? "parallel" : "staggered",
    reportBudget: preset.reportBudget,
    // Per-effort explore→exploit threshold: low always exploits (strict, on-topic);
    // medium tightens at 40% KV used; high explores novel facts until 60% used.
    shouldExplore: preset.shouldExplore,
  };
  // Ask (skipPlanner): accept a direct free-text answer from context — 0 tool calls OK.
  // Non-Ask multi-agent research keeps the tool-gathering guard (a lazy research agent
  // that answers without evidence is still pushed to research/recovery). Both branches
  // extend SourceWeavingPolicy so a voluntary report() return is inline-cited at capture.
  return isAsk ? new DirectAnswerPolicy(opts) : new SourceWeavingPolicy(opts);
}

/**
 * Structured-sources citation weave (DRB FACT fix). The `report()` terminal tool
 * carries a grammar-forced `sources: [{title, url}]` field (see
 * {@link citedReportTool}); on a voluntary terminal return this override weaves
 * those sources into the result string — bare source URLs become `[title](url)`
 * plus an appended `Sources:` block (see {@link weaveSourcesIntoResult}) — BEFORE
 * the string becomes `agent.result`. That single seam covers both downstream
 * consumers of a voluntary return: the synthesis findings assembly and the
 * annexure writer (both read `agent.result` / the `agent:return` event's `result`).
 *
 * `onProduced` is the base policy's PUBLIC entry point; the actual capture lives
 * in its `private _handleTerminalTool`. Rather than reach into a private method,
 * we post-process its result: `super.onProduced` returns `{type:'return', result}`
 * with `result` = the plain `result` arg; we re-parse the same tool call for its
 * sibling `sources` and weave. Non-return actions (nudge/idle/tool_call) and
 * non-terminal or unparseable calls pass through untouched — matching the base's
 * own JSON-parse fallback (raw arguments, no weave).
 *
 * KNOWN GAP: the RECOVERY capture path (an agent killed by pressure/time and
 * force-recovered) sets `agent.result` inside `@lloyal-labs/lloyal-agents`'
 * recovery path, which exposes no policy hook — so recovered agents' findings are
 * NOT woven from here (the grammar still forces `sources`; they're just dropped at
 * capture). Voluntary returns (the dominant path) are fully covered.
 */
class SourceWeavingPolicy extends DefaultAgentPolicy {
  override onProduced(
    ...args: Parameters<DefaultAgentPolicy["onProduced"]>
  ): ReturnType<DefaultAgentPolicy["onProduced"]> {
    const action = super.onProduced(...args);
    if (action.type !== "return") return action;
    const [, parsed, , config] = args;
    const tc = parsed.toolCalls[0];
    if (!tc || tc.name !== config.terminalToolName) return action;
    let sources: unknown;
    try {
      sources = (JSON.parse(tc.arguments) as { sources?: unknown }).sources;
    } catch {
      // Base fell back to raw arguments (unparseable) — nothing to weave.
      return action;
    }
    return { ...action, result: weaveSourcesIntoResult(action.result, sources) };
  }
}

/**
 * Direct-answer policy — the agent's free text IS the answer, accepted even with ZERO
 * tool calls. `DefaultAgentPolicy._handleNoToolCall` gates accepting free text as the
 * result behind `agent.toolCallCount > 0` — a guard against research agents skipping
 * evidence-gathering; this bypasses it (the streamed content becomes `agent.result` via
 * the `free_text_return` action → a voluntary `agent:return`, no drop/recovery).
 *
 * Used by **synth** (no tools — the prompt + parent KV ARE the evidence) and by **Ask**
 * (a single research agent answering directly from the prior report's context, via
 * `createResearchPolicy(..., isAsk=true)`). Ask can still choose to gather evidence
 * (tool calls) — this only ensures a direct answer isn't discarded.
 */
class DirectAnswerPolicy extends SourceWeavingPolicy {
  override onProduced(
    ...args: Parameters<DefaultAgentPolicy["onProduced"]>
  ): ReturnType<DefaultAgentPolicy["onProduced"]> {
    const [, parsed] = args;
    if (!parsed.toolCalls[0] && parsed.content) {
      return { type: "free_text_return", content: parsed.content };
    }
    // Report-tool returns flow through SourceWeavingPolicy's weave; synth (no
    // terminal tool) and Ask free-text answers are unaffected (no-op weave).
    return super.onProduced(...args);
  }
}

/**
 * Recon turn budget. A pre-flight probe is shallow — ~2 searches per source
 * then a report. Enforced HARD via {@link ReconPolicy.shouldExit}: the base
 * policy only soft-nudges on turns ("report now"), which an over-eager recon
 * agent ignores, looping to the time hard limit (the recon nudge-loop trace).
 * Sized at 4 so a time-nudged agent gets one more turn to comply with the
 * report nudge voluntarily before being force-recovered.
 */
const RECON_MAX_TURNS = 4;

/**
 * Recon policy — research policy with a hard turn cap. Past RECON_MAX_TURNS the
 * pool kills the agent and `recoverInline` extracts its coverage via the recon
 * recovery prompt, so a probe always terminates with a coverage line instead of
 * nudge-looping. A voluntary `report` before the cap still produces a clean
 * result. `shouldExit` is checked before each turn produces, so this preempts
 * the base policy's soft turn-limit nudge entirely.
 */
class ReconPolicy extends DefaultAgentPolicy {
  override shouldExit(agent: Agent, pressure: ContextPressure): boolean {
    if (agent.turns >= RECON_MAX_TURNS) return true;
    return super.shouldExit(agent, pressure);
  }
}

function createReconPolicy(recoverPrompt: Prompt): ReconPolicy {
  return new ReconPolicy({
    budget: {
      context: { softLimit: 2048, hardLimit: 1024 },
      // Sized for the slowest probe path observed in traces: one corpus
      // `search` reranks the full chunk index and takes ~30-40s, so 60s
      // soft / 90s hard was too tight and time-nudged after the first
      // search. 120s soft / 180s hard gives room for ~2 searches before
      // nudges + the report turn.
      time: { softLimit: 120_000, hardLimit: 180_000 },
    },
    // Recovery extracts coverage from a force-killed probe. Default
    // `minToolCalls: 2` skips recovery on agents that only got ONE search
    // dispatched (the rest got nudged away) — which produced empty coverage
    // for the slow corpus probe. One probe is enough signal for recon.
    recovery: { prompt: recoverPrompt, minToolCalls: 1 },
    terminalToolName: "report",
  });
}

// ── Public types ────────────────────────────────────────────────

export type QueryResult =
  | { type: "done" }
  | { type: "clarify"; plan: PlanResult }
  | { type: "research_plan"; plan: PlanResult };

export interface HarnessOpts {
  maxTurns: number;
  findingsMaxChars?: number;
  reasoningMode: "flat" | "deep";
  /** Run effort preset — pure policy (budget + planner breadth + recovery cap),
   *  no prompt effect. @see EFFORT_PRESETS. */
  effort: Effort;
}

export interface RunQueryOpts extends HarnessOpts {
  /** Extra context appended to the planner prompt — used to thread
   *  clarification Q&A back in for re-planning. */
  context?: string;
  /** performance.now() at the user's submit. Used as the `wallTimeMs`
   *  baseline in the `complete` event. */
  wallStartMs: number;
  /** Fires after the clarify gate but before passthrough/research starts.
   *  Used by main.ts to start the run-dir for artifact writes. */
  onStart?: () => void;
  /** Per-query app subset, by `manifest.name`. When set, the recon,
   *  planner, and research stages all operate on `registry.enabled()`
   *  filtered to this list. When omitted, the full enabled set is used
   *  (preserves prior behavior). The Composer derives this from
   *  `state.participation` at submit time. */
  appFilter?: readonly string[];
}

export interface RunResearchPlanOpts extends HarnessOpts {
  wallStartMs: number;
  /** Per-query app subset, by `manifest.name`. Mirrors `RunQueryOpts.appFilter`
   *  for the accept_plan path (where the planner already ran with the filter
   *  and the research pool needs the same subset). When omitted, the full
   *  enabled set is used. */
  appFilter?: readonly string[];
  /** Q1.5: signals whether the caller already prefilled the user-side of the
   *  next trunk turn via `session.prefillUser` (true) or left it to
   *  `runResearchPlan` to commit the full pair (false, default). True after a
   *  clarify round in which `submit_clarification` exposed the user's answer
   *  to the planner via KV before invoking it; in that case the trunk has a
   *  dangling user side and the research-findings commit must use
   *  `session.prefillAssistant` to close the pair rather than `commitTurn`
   *  (which would re-emit the user side). */
  userSidePending?: boolean;
  /** Ask mode (composer `skipPlanner`): a single warm-forked agent that may answer
   *  DIRECTLY from the prior report's context. Uses `DirectAnswerPolicy` so a free-text
   *  answer with 0 tool calls is captured (not discarded by the tool-gathering guard).
   *  Omitted/false ⇒ normal research policy (evidence-gathering enforced). */
  isAsk?: boolean;
}

export interface PreflightResult {
  /** Prose per-entity coverage summary the recon agent reported. Empty when
   *  the agent produced nothing usable. */
  coverage: string;
  tokens: number;
  toolCalls: number;
  timeMs: number;
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Content nudge for the structured `report()` sources field, appended to every
 * research agent's per-task system prompt (see {@link appPreamble}). The grammar
 * forces the field's SHAPE ({title, url} objects); this nudges its CONTENT toward
 * real URLs from tool results (not corpus file paths) and inline citations. Kept
 * as a clearly-separated trailing sentence.
 */
const REPORT_CITATION_NUDGE =
  "\n\nWhen you call report(): cite each claim inline as [title](url) using the exact URL from tool results, and fill the sources field with every {title, url} you used (real URLs from tool results, not file paths).";

/**
 * Per-spawn preamble for an agent assigned to `app`. `renderAgentPreamble`
 * prepends the boundary marker and renders the app's `skill.eta`; we merge the
 * app's own `source.promptData()` (corpus supplies `it.toc`; web supplies
 * nothing) into the render context, exactly as the old `renderWorkerPrompt`
 * spread `source.promptData()` into ctx. The structured-sources citation nudge is
 * appended last so research agents fill report()'s sources field with real URLs.
 */
function appPreamble(app: App, ctx: AgentRenderCtx): string {
  return (
    renderAgentPreamble(app, ctx as AgentRenderCtx & Record<string, unknown>) +
    REPORT_CITATION_NUDGE
  );
}

/**
 * Spine = framework catalog + harness-trusted app reference data.
 *
 * `renderSpine` stays prose-free by design (cross-app injection defense:
 * the shared prefix is read by every agent in the pool). Appending app
 * `promptData` is the HARNESS's trust call — reasoning.run ships
 * first-party apps only. Rendered once and prefix-shared by every fork,
 * instead of duplicated into each spawn's suffix (six 4.8k-token
 * TOC-bearing suffixes overran a 32k context: trace-2026-06-11T06-21).
 */
function renderSpineWithReferenceData(apps: readonly App[]): string {
  const blocks: string[] = [];
  for (const app of apps) {
    const toc = app.source.promptData()["toc"];
    if (typeof toc === "string" && toc.trim()) {
      blocks.push(
        `\n\n# ${app.manifest.protocol.name} — available files\n${toc}`,
      );
    }
  }
  return renderSpine({ apps }) + blocks.join("");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function startTimer(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}

/**
 * Resolve the effective App set for the current operation. Returns
 * `registry.enabled()` filtered by `appFilter` (by `manifest.name`) when
 * the caller passes one; otherwise returns the full enabled set.
 *
 * The filter is the per-query App-participation knob: the Composer
 * derives it from `state.participation` at submit time and threads it
 * through `RunQueryOpts.appFilter` / `RunResearchPlanOpts.appFilter`.
 * All in-harness consumers (recon, planner-context, research pool) call
 * this instead of `registry.enabled()` directly so the filter applies
 * uniformly.
 */
function* effectiveApps(filter?: readonly string[]): Operation<readonly App[]> {
  const registry = yield* AppRegistryCtx.expect();
  const all = registry.enabled();
  if (!filter) return all;
  const allow = new Set(filter);
  return all.filter((a) => allow.has(a.manifest.name));
}

/**
 * Synthetic single-task research plan. Used by the START path to
 * bypass the planner — the user's literal query becomes the only
 * research task. Combined with the synth gate inside runResearchPlan
 * (skips synth when tasks.length === 1), this collapses START into
 * "research the literal query, return the agent's report."
 */
export function singleTaskPlan(query: string): PlanResult {
  return {
    intent: "research",
    tasks: [{ description: query }],
    clarifyQuestions: [],
    tokenCount: 0,
    timeMs: 0,
  };
}

/**
 * Passthrough — stream a direct answer from session.trunk after appending
 * the user's query as a fresh user turn. No research pool runs; the
 * answer comes from the prior Q&A already in trunk's KV.
 *
 * Caller ensures session.trunk exists; this throws otherwise.
 */
function* runPassthrough(
  query: string,
  session: Session,
): Operation<{ answer: string; tokenCount: number; timeMs: number }> {
  const trunk = session.trunk;
  if (!trunk) {
    throw new Error("runPassthrough: session has no trunk");
  }

  const ctx: SessionContext = yield* Ctx.expect();
  const sep = ctx.getTurnSeparator();
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([{ role: "user", content: query }]),
    { addGenerationPrompt: true, enableThinking: false },
  );
  const userTurnTokens = [...sep, ...ctx.tokenizeSync(prompt, false)];
  yield* call(() => trunk.prefill(userTurnTokens));

  const t = performance.now();
  let tokenCount = 0;
  const pieces: string[] = [];
  for (;;) {
    const { token, text, isStop } = trunk.produceSync();
    if (isStop) break;
    yield* call(() => trunk.commit(token));
    tokenCount++;
    pieces.push(text);
  }
  return { answer: pieces.join(""), tokenCount, timeMs: performance.now() - t };
}

/**
 * Pre-flight recon. One probe agent PER enabled app runs in parallel — the
 * same `agentPool` + `parallel` machinery the research pool uses — each
 * searching its OWN source for the query's entities and reporting which parts
 * that source covers. The joined coverage grounds the planner's per-task `app`
 * routing (RFC: multi-app composition — route by *trying* the apps, not blind
 * `useWhen`).
 *
 * Runs only when ≥2 apps are installed (nothing to route between otherwise).
 * Each agent is hard-capped at {@link RECON_MAX_TURNS} via {@link ReconPolicy}:
 * past the cap the pool kills + recovers it (coverage from what it saw) rather
 * than soft-nudge-looping. Probe calls stream as `agent:*` events, so the UI
 * shows discovery live. Recon is throwaway — its retrievals aren't reused by
 * the research agents (they re-search deeper); only the coverage feeds forward.
 */
export function* runPreflight(
  query: string,
  session: Session,
  filter?: readonly string[],
): Operation<PreflightResult> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  const apps = yield* effectiveApps(filter);

  yield* send({ type: "preflight:start", query, appCount: apps.length });
  const timer = startTimer();

  const reconTools = [...apps.flatMap((a) => [...a.tools]), reportTool];
  const spinePrompt = renderSpineWithReferenceData(apps);
  const currentDate = today();

  const { coverage, tokens, toolCalls } = yield* withSpine<{
    coverage: string;
    tokens: number;
    toolCalls: number;
  }>(
    {
      parent: session.trunk ?? undefined,
      systemPrompt: spinePrompt,
      tools: reconTools,
    },
    function* (reconSpine) {
      const preflight = yield* resolvePrompt("preflight");
      const reconRecover = yield* resolvePrompt("preflight-recover");
      const probe = yield* agentPool({
        tools: reconTools,
        parent: reconSpine,
        terminal: reportTool,
        maxTurns: RECON_MAX_TURNS,
        pruneOnReturn: true,
        policy: createReconPolicy(reconRecover),
        enableThinking: true,
        orchestrate: parallel(
          apps.map((app, i) => ({
            content: renderTemplate(preflight.user, {
              query,
              date: currentDate,
              app: {
                name: app.manifest.protocol.name,
                useWhen: app.manifest.protocol.useWhen,
                tools: app.manifest.protocol.tools,
                // Surface the source's content advert so the recon agent
                // can recognize what each source actually contains BEFORE
                // probing — fixes TICK-005 (corpus probe agent reading
                // HDK chunks as "Lloyal platform stuff" because it didn't
                // know the corpus IS the HDK docs). Duck-typed because
                // not every source implements promptData (web doesn't).
                // Graduates to Source.describe() framework affordance in
                // TICK-018; for now reasoning.run pulls it directly.
                contents:
                  (app.source as { promptData?: () => { toc?: string } })
                    .promptData?.()?.toc ?? null,
              },
            }),
            systemPrompt: preflight.system,
            assignedApp: app.manifest.name,
            seed: 2000 + i,
          })),
        ),
      });

      // Join each source's coverage under its protocol name so the planner can
      // see which source holds what. Agents align with `apps` by spawn order.
      const lines = probe.agents
        .map((a, i) => {
          const name = apps[i]?.manifest.protocol.name ?? `source ${i + 1}`;
          const body = a.result?.trim();
          return body ? `### ${name}\n${body}` : null;
        })
        .filter((l): l is string => l !== null);

      return {
        coverage: lines.join("\n\n"),
        tokens: probe.totalTokens,
        toolCalls: probe.totalToolCalls,
      };
    },
  );

  const result: PreflightResult = { coverage, tokens, toolCalls, timeMs: timer() };
  yield* send({
    type: "preflight:done",
    coverage,
    tokens: result.tokens,
    toolCalls: result.toolCalls,
    timeMs: result.timeMs,
  });
  return result;
}

/**
 * Memoizes preflight coverage for the lifetime of the boot session.
 *
 * Coverage is a pure function of `(query, enabledApps)`; the enabled-app
 * set is constant within a boot scope (a `/model` or `/reranker` change
 * unwinds that scope and rebuilds the cache), so `query` alone is a sufficient
 * key. This is what lets a clarify-answer or change_mode re-invoke
 * `runQuery(sameQuery)` without re-running the ~170 s recon probe — the second
 * call hits the memo. See TICK-004 (and TICK-014, subsumed).
 */
export interface CoverageCache {
  getOrCompute(
    query: string,
    compute: () => Operation<PreflightResult>,
  ): Operation<PreflightResult>;
}

/**
 * Construct a per-boot coverage cache. Created once at the command-loop scope
 * via `CoverageCacheCtx.set` and cleared on scope teardown.
 */
export function createCoverageCache(): Operation<CoverageCache> {
  return resource(function* (provide) {
    const memo = new Map<string, PreflightResult>();
    try {
      yield* provide({
        *getOrCompute(query, compute) {
          const hit = memo.get(query);
          if (hit) return hit; // reuse — `compute` (which emits preflight:* events) never fires
          const fresh = yield* compute();
          memo.set(query, fresh);
          return fresh;
        },
      });
    } finally {
      memo.clear();
    }
  });
}

export const CoverageCacheCtx = createContext<CoverageCache>(
  "reasoning.coverageCache",
);

/**
 * Resolve preflight coverage for `query`, computing it at most once per
 * boot session. The ≥2-app gate lives here (a single source has nothing to
 * route between, so coverage is empty and no probe runs). The caller folds
 * the returned prose into the planner context.
 */
export function* useCoverage(
  query: string,
  session: Session,
  filter?: readonly string[],
): Operation<PreflightResult> {
  const apps = yield* effectiveApps(filter);
  if (apps.length < 2) {
    return { coverage: "", tokens: 0, toolCalls: 0, timeMs: 0 };
  }
  const cache = yield* CoverageCacheCtx.expect();
  // Compose the cache key from query + sorted filter so distinct
  // participation subsets get distinct cached coverage. Same query +
  // same subset across clarify rounds still hits the cache.
  const key = filter
    ? `${query}|${[...filter].sort().join(",")}`
    : query;
  return yield* cache.getOrCompute(key, () => runPreflight(query, session, filter));
}

/**
 * Run the planner LLM. Emits a `query` event and a `plan` event.
 * Returns the raw PlanResult so callers can route based on intent.
 */
export function* runPlanner(
  query: string,
  session: Session,
  opts: { reasoningMode: "flat" | "deep"; effort: Effort; context?: string; appFilter?: readonly string[] },
): Operation<PlanResult> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  yield* send({ type: "query", query, warm: !!session.trunk });

  const currentDate = today();
  const planPrompt = yield* resolvePrompt(opts.reasoningMode === "flat" ? "plan-flat" : "plan");
  // Grounded planner routing (RFC: multi-app composition). With ≥2 apps the
  // pre-flight recon agent has already probed each source and folded a coverage
  // summary into `opts.context`; passing `availableApps` re-adds the per-task
  // `app` enum to the plan grammar so the planner assigns each task to the
  // source the coverage shows holds it — evidence-grounded, not blind `useWhen`.
  // `appForTask` in runResearchPlan consumes `task.app`. With <2 apps there is
  // nothing to route between, so the field is dropped and tasks fall back to the
  // primary app + open reads (authGuard).
  const apps = yield* effectiveApps(opts.appFilter);
  const planTool = new PlanTool({
    prompt: planPrompt,
    session,
    // Caps the tasks-array `maxItems` (grammar-enforced) and the `it.count`
    // rendered into the planner prompt. 6 is the upper bound that survives
    // the 8-agent shared-spine overflow seen in
    // trace-2026-06-01T07-46-17-924 (8 corpus-heavy tasks → all agents
    // softcut/settle-reject, no recovery, empty synth).
    maxTasks: EFFORT_PRESETS[opts.effort].maxTasks,
    availableApps: apps.length >= 2 ? apps : undefined,
  });
  const planContext = opts.context
    ? `Today's date: ${currentDate}\n\n${opts.context}`
    : `Today's date: ${currentDate}`;
  const plan = (yield* planTool.execute({
    query,
    context: planContext,
  })) as PlanResult;

  yield* send({
    type: "plan",
    intent: plan.intent,
    tasks: plan.tasks,
    clarifyQuestions: plan.clarifyQuestions,
    tokenCount: plan.tokenCount,
    timeMs: plan.timeMs,
  });

  return plan;
}

// ── Pipeline ────────────────────────────────────────────────────

/**
 * Top of pipeline: run planner, dispatch on intent.
 *
 *   - intent='clarify'      → return; caller drives the clarify dialog
 *   - intent='passthrough'  → run passthrough inline (if trunk exists),
 *                             return done. If no trunk, fall through to
 *                             research_plan with a single-task synthetic
 *                             plan since passthrough requires a warm
 *                             session.
 *   - intent='research'     → return the plan; caller decides whether to
 *                             show plan-review or run it directly.
 *
 * For START (skip planner): main.ts builds a singleTaskPlan(query) and
 * calls runResearchPlan directly — never enters this function.
 */
export function* runQuery(
  query: string,
  session: Session,
  opts: RunQueryOpts,
): Operation<QueryResult> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  // Defensive guard: empty `appFilter` is a programming error — the
  // Composer's submit handler blocks zero-source submission with a
  // toast, so reaching here with [] means the auto-submit `--query`
  // path or a future caller forgot the same check. Fail loudly.
  if (opts.appFilter && opts.appFilter.length === 0) {
    throw new Error(
      "runQuery: appFilter is an empty array — at least one source must be included.",
    );
  }

  // Pre-flight recon (RFC: multi-app composition). Probe each source for the
  // query's entities BEFORE planning and fold the coverage summary into the
  // planner context — that's what makes the planner's per-task `app` routing
  // grounded rather than blind. `useCoverage` memoizes per `(query, appFilter)`
  // for the boot session, so a clarify-answer / change_mode re-invocation of
  // `runQuery` with the same filter reuses the probe instead of re-running
  // it; it also applies the ≥2-app gate internally (a single effective source
  // has nothing to route between → empty coverage).
  const preflight = yield* useCoverage(query, session, opts.appFilter);
  let plannerContext = opts.context;
  if (preflight.coverage) {
    const coverageSection =
      "Source coverage (from a pre-flight probe of each source for this query — " +
      "use it as the primary signal when assigning each task's `app`):\n" +
      preflight.coverage;
    plannerContext = [opts.context, coverageSection]
      .filter(Boolean)
      .join("\n\n");
  }

  yield* send({
    type: "plan:start",
    query,
    mode: opts.reasoningMode,
  });

  const plan = yield* runPlanner(query, session, {
    reasoningMode: opts.reasoningMode,
    effort: opts.effort,
    context: plannerContext,
    appFilter: opts.appFilter,
  });

  if (plan.intent === "clarify") {
    return { type: "clarify", plan };
  }

  // Passthrough fast-path. Gated on trunk existence: passthrough forks
  // from the warm spine, so a cold session can't take it. Without trunk
  // we degrade to running the query as a single-task research plan,
  // which transparently gives the user an answer either way.
  if (plan.intent === "passthrough") {
    if (!session.trunk) {
      const fallbackPlan = singleTaskPlan(query);
      opts.onStart?.();
      yield* runResearchPlan(query, fallbackPlan, session, { ...opts });
      return { type: "done" };
    }
    opts.onStart?.();
    const pt = yield* runPassthrough(query, session);
    yield* send({ type: "answer", text: pt.answer });
    yield* finalizePassthrough(plan, pt, opts.wallStartMs);
    return { type: "done" };
  }

  return { type: "research_plan", plan };
}

/**
 * Run a research plan to completion: research pool → (synth iff fan-in)
 * → answer + stats + complete + commitTurn.
 *
 * Used for both:
 *   - accept_plan path: planner-built plan, possibly edited via the
 *     plan-review dialog
 *   - START path: synthetic singleTaskPlan(query) bypassing the planner
 *
 * Synth gate (single conditional, encodes invariant): synth aggregates
 * findings across multiple agents into one argument. tasks.length === 1
 * has nothing to aggregate — the agent's report IS the answer.
 */
export function* runResearchPlan(
  query: string,
  plan: PlanResult,
  session: Session,
  opts: RunResearchPlanOpts,
): Operation<void> {
  if (plan.intent !== "research") {
    throw new Error(
      `runResearchPlan: expected plan.intent=research, got ${plan.intent}`,
    );
  }

  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  const tasks = plan.tasks;
  const currentDate = today();

  yield* send({
    type: "research:start",
    agentCount: tasks.length,
    mode: opts.reasoningMode,
  });
  const researchTimer = startTimer();

  // App protocol: the registry (set on AppRegistryCtx by createAppRegistry at
  // boot) is the source of truth. Apps are born already-bound to the reranker
  // (no source.bind step). The spine carries every app's catalog metadata AND
  // every app's tools (`researchTools` below), so each agent can read across
  // ALL apps — routing dissolves at execution time (RFC §3.2 M2 authGuard:
  // read tools are open; only `protected` tools are grant-gated, and these
  // apps have none). `task.app` is now a soft routing hint, not a tool lock:
  // it selects which app's preamble (skill.eta) the agent gets and drives the
  // per-task UI chip; the model is free to pivot to another app's read tools
  // mid-task. App-agnostic tasks fall back to the primary.
  const apps = yield* effectiveApps(opts.appFilter);
  const primaryApp = apps[0];
  const byProtocol = new Map(apps.map((a) => [a.manifest.protocol.name, a]));
  const appForTask = (task: ResearchTask): App =>
    (task.app ? byProtocol.get(task.app) : undefined) ?? primaryApp;
  // The scorer is reranker-backed and the reranker is shared across all apps
  // (RerankerCtx), so one pool-level scorer is equivalent regardless of which
  // app a given agent is assigned.
  const primaryScorer = primaryApp.source.createScorer(query);
  // citedReportTool replaces rig's reportTool for the research pool: same 'report'
  // terminal name + no-op semantics, but its schema adds the required `sources`
  // field (grammar-forced). Recon keeps rig's reportTool (its coverage output isn't
  // cited). The pool builds the terminal grammar from `terminal:` below, so the
  // registry entry and the `terminal:` arg MUST be the same tool.
  const researchTools = [...apps.flatMap((a) => [...a.tools]), citedReportTool];
  const spinePrompt = renderSpineWithReferenceData(apps);

  let synthTimeMs = 0;
  let researchTimeMs = 0;

  const {
    answer,
    totalTokens: researchTotalTokens,
    totalToolCalls: researchTotalToolCalls,
    synthTokens: synthTotalTokens,
  } = yield* withSpine<{
    answer: string;
    totalTokens: number;
    totalToolCalls: number;
    synthTokens: number;
  }>(
    {
      parent: session.trunk ?? undefined,
      systemPrompt: spinePrompt,
      tools: researchTools,
    },
    function* (querySpine) {
      if (opts.reasoningMode === "flat") {
        yield* send({ type: "fanout:tasks", tasks });
      }

      const recoveryPrompt = yield* resolvePrompt("recovery");
      const research = yield* agentPool({
        tools: researchTools,
        parent: querySpine,
        terminal: citedReportTool,
        maxTurns: opts.maxTurns,
        pruneOnReturn: true,
        policy: createResearchPolicy(opts.effort, opts.reasoningMode, opts.isAsk, recoveryPrompt),
        scorer: primaryScorer,
        enableThinking: true,
        orchestrate:
          opts.reasoningMode === "flat"
            ? parallel(
                tasks.map((task: ResearchTask, i: number) => {
                  const app = appForTask(task);
                  return {
                    content: taskToContent(task),
                    systemPrompt: appPreamble(app, {
                      maxTurns: opts.maxTurns,
                      agentCount: tasks.length,
                      siblingTasks: tasks
                        .filter((_, j) => j !== i)
                        .map((t) => t.description),
                      date: currentDate,
                      taskIndex: 0,
                    }),
                    assignedApp: app.manifest.name,
                    seed: 1000 + i,
                  };
                }),
              )
            : chain(tasks, (task: ResearchTask, i: number) => {
                const app = appForTask(task);
                return {
                  task: {
                    content: taskToContent(task),
                    systemPrompt: appPreamble(app, {
                      maxTurns: opts.maxTurns,
                      agentCount: 1,
                      siblingTasks: [],
                      date: currentDate,
                      taskIndex: i,
                    }),
                    assignedApp: app.manifest.name,
                  },
                  userContent: `Research task: ${task.description}`,
                  beforeSpawn: function* () {
                    yield* send({
                      type: "spine:task",
                      taskIndex: i,
                      taskCount: tasks.length,
                      description: task.description,
                    });
                    yield* send({
                      type: "spine:source",
                      taskIndex: i,
                      source: app.source.name,
                    });
                  },
                  afterExtend: function* (delta: number, position: number) {
                    yield* send({
                      type: "spine:task:done",
                      taskIndex: i,
                      stageFindings: delta,
                      accumulated: position,
                    });
                  },
                };
              }),
      });

      // Emit research:done HERE — before synth starts — so the flat-mode
      // panel's finalize happens while the cursor is still directly below
      // the panel.
      researchTimeMs = researchTimer();
      yield* send({
        type: "research:done",
        totalTokens: research.totalTokens,
        totalToolCalls: research.totalToolCalls,
        timeMs: researchTimeMs,
      });

      // Synth gate. Synth aggregates fan-in across multiple sources;
      // single-task runs have nothing to aggregate — the agent's
      // report IS the answer. The synth prompts also assume multi-agent
      // framing, so running them on a single source produces awkward
      // output. Skipping saves ~120s of LLM time on START runs.
      if (tasks.length === 1) {
        return {
          answer: research.agents[0]?.result?.trim() ?? "",
          totalTokens: research.totalTokens,
          totalToolCalls: research.totalToolCalls,
          synthTokens: 0,
        };
      }

      // All-empty gate: every agent was cut before producing findings
      // (capacity failure, mass tool outage). Synthesizing from nothing
      // yields a confident hallucination sourced from model priors —
      // 16k chars of it in trace-2026-06-11T06-21. Say so honestly instead.
      if (research.agents.every((a) => !a.result?.trim())) {
        return {
          answer:
            "Research produced no findings — every agent was cut before completing its task (see trace for drop reasons). No synthesis was attempted.",
          totalTokens: research.totalTokens,
          totalToolCalls: research.totalToolCalls,
          synthTokens: 0,
        };
      }

      yield* send({ type: "synthesize:start" });
      const synthT = startTimer();

      const synthPrompt = yield* resolvePrompt(
        opts.reasoningMode === "flat" ? "synthesize-flat" : "synthesize",
      );
      const findings =
        opts.reasoningMode === "flat"
          ? research.agents
              .map((a, i) => {
                const desc = tasks[i]?.description ?? `task ${i + 1}`;
                // Consumer-side guard: a dangling <tool_call> fragment in a
                // finding is an in-context demonstration that primes the
                // (tool-less) synth agent to emit tool calls. The framework
                // sanitizes at result capture; this catches anything that
                // slips through a future capture path.
                const body =
                  a.result
                    ?.replace(/<tool_call>(?:(?!<\/tool_call>)[\s\S])*$/, "")
                    .trim() || "(no findings)";
                return `### Agent ${i + 1}: ${desc}\n\n${body}`;
              })
              .join("\n\n")
          : undefined;
      const synthCtx = {
        query,
        findings,
        agentCount: tasks.length,
      };

      const synth = yield* useAgent({
        systemPrompt: renderTemplate(synthPrompt.system, synthCtx),
        task: renderTemplate(synthPrompt.user, synthCtx),
        parent: querySpine,
        policy: new DirectAnswerPolicy(),
        maxTurns: opts.maxTurns,
      });

      synthTimeMs = synthT();
      yield* send({
        type: "synthesize:done",
        agentId: synth.id,
        ppl: synth.branch.disposed ? 0 : synth.branch.perplexity,
        tokenCount: synth.tokenCount,
        toolCallCount: synth.toolCallCount,
        timeMs: synthTimeMs,
      });

      return {
        answer: synth.result || "",
        totalTokens: research.totalTokens,
        totalToolCalls: research.totalToolCalls,
        synthTokens: synth.tokenCount,
      };
    },
  );

  yield* send({ type: "answer", text: answer });
  if (answer) {
    if (opts.userSidePending) {
      // Clarify path: user-side already on trunk via prefillUser; close the
      // dangling pair by appending the assistant side only.
      yield* call(() => session.prefillAssistant(answer));
    } else {
      // No-clarify path (START or first-shot accept_plan): bootstrap or
      // append the full (query, answer) pair atomically.
      yield* call(() => session.commitTurn(query, answer));
    }
  }

  yield* finalizeResearch({
    plan,
    researchTokens: researchTotalTokens,
    researchToolCalls: researchTotalToolCalls,
    researchTimeMs,
    synthTokens: synthTotalTokens,
    synthTimeMs,
    wallStartMs: opts.wallStartMs,
    send,
  });
}

// ── Finalize helpers ────────────────────────────────────────────

function* finalizePassthrough(
  plan: PlanResult,
  pt: { tokenCount: number; timeMs: number },
  wallStartMs: number,
): Operation<void> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;

  const timings: OpTiming[] = [
    {
      label: "Plan",
      tokens: plan.tokenCount,
      detail: plan.intent,
      timeMs: plan.timeMs,
    },
    {
      label: "Passthrough",
      tokens: pt.tokenCount,
      detail: "trunk stream",
      timeMs: pt.timeMs,
    },
  ];
  yield* send({
    type: "stats",
    timings,
    ctxPct: Math.round((100 * p.cellsUsed) / ctxTotal),
    ctxPos: p.cellsUsed,
    ctxTotal,
  });
  yield* send({
    type: "complete",
    data: {
      intent: plan.intent,
      planTokens: plan.tokenCount,
      passthroughTokens: pt.tokenCount,
      wallTimeMs: Math.round(performance.now() - wallStartMs),
      planMs: Math.round(plan.timeMs),
      passthroughMs: Math.round(pt.timeMs),
    },
  });
  // Trunk already contains the streamed user+assistant pair via
  // produceSync+commit; no session.commitTurn needed.
}

function* finalizeResearch(args: {
  plan: PlanResult;
  researchTokens: number;
  researchToolCalls: number;
  researchTimeMs: number;
  synthTokens: number;
  synthTimeMs: number;
  wallStartMs: number;
  send: (ev: StepEvent) => Operation<void>;
}): Operation<void> {
  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;

  const timings: OpTiming[] = [
    {
      label: "Plan",
      tokens: args.plan.tokenCount,
      detail: args.plan.intent,
      timeMs: args.plan.timeMs,
    },
    {
      label: "Research",
      tokens: args.researchTokens,
      detail: `${args.researchToolCalls} tools`,
      timeMs: args.researchTimeMs,
    },
    {
      label: "Synthesize",
      tokens: args.synthTokens,
      detail: args.synthTokens > 0 ? "spine fork" : "skipped (single task)",
      timeMs: args.synthTimeMs,
    },
  ];

  yield* args.send({
    type: "stats",
    timings,
    ctxPct: Math.round((100 * p.cellsUsed) / ctxTotal),
    ctxPos: p.cellsUsed,
    ctxTotal,
  });

  yield* args.send({
    type: "complete",
    data: {
      intent: args.plan.intent,
      planTokens: args.plan.tokenCount,
      agentTokens: args.researchTokens,
      synthTokens: args.synthTokens,
      totalToolCalls: args.researchToolCalls,
      agentCount: args.plan.tasks.length,
      wallTimeMs: Math.round(performance.now() - args.wallStartMs),
      planMs: Math.round(args.plan.timeMs),
      researchMs: Math.round(args.researchTimeMs),
      synthMs: Math.round(args.synthTimeMs),
    },
  });
}
