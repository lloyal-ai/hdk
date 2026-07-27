/**
 * Your harness — the platform contract: a headless generator
 * `harness(ctx, events, commands)`.
 *
 * `ctx` is the resident model; `events` streams your `WorkflowEvent`s to whatever
 * surface is mounted; `commands` delivers that surface's `Command`s back. This
 * harness runs the RACE/DRB-tuned pipeline — pre-flight recon → planner →
 * parallel/chain research pool → synthesis — over the substrate a target's boot
 * established. It reads `RunnerCtx` (see ./runner-ctx.ts) for the edge-shell
 * concerns it can't own: the wind-down / cancel signals, the live config, the
 * trace sink. (The reranker is NOT a Runner concern — the boot's
 * `provisionAppModels` publishes it on `RerankerCtx`.)
 *
 * The pipeline itself (`runQuery` / `runResearchPlan` / policies / the 7 tuned
 * `.eta` prompts) lives in ./pipeline.ts — this file is the command loop + app
 * boot that drives it. Edit the pipeline to change what your intelligence does;
 * drop a `prompts/<name>.eta` into the project to override a tuned prompt.
 *
 * SNAPSHOT: reasoning.run @ 0.8.0 — a curated separate copy of its pipeline,
 * conforming to the harness.dev new conventions. Drift from upstream is
 * expected and accepted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, each, call } from "effection";
import type { Operation, Task, Signal } from "effection";
import type { SessionContext } from "@lloyal-labs/sdk";
import {
  initAgents,
  WindDown,
  CancelAgent,
  reconstructBranch,
} from "@lloyal-labs/lloyal-agents";
import type {
  App,
  AppFactory,
  AppRegistry,
  AppConfigStore,
} from "@lloyal-labs/lloyal-agents";
import type { EventBus } from "@lloyal-labs/binding";
import {
  createInMemoryConfigStore,
  createAppRegistry,
} from "@lloyal-labs/rig";
import type { PlanResult } from "@lloyal-labs/rig";
import { createWebApp } from "@lloyal-labs/web-app";
import { createCorpusApp } from "@lloyal-labs/corpus-app";
import { RunnerCtx } from "./runner-ctx.js";
import {
  runQuery,
  runResearchPlan,
  singleTaskPlan,
  createCoverageCache,
  CoverageCacheCtx,
  PromptsCtx,
  type Effort,
} from "./pipeline.js";
import type { WorkflowEvent, Command } from "./protocol.js";
import type { AppDescriptor } from "./state.js";
import { RunDirSink } from "./run-dir.js";
import { resolvePath } from "./path-utils.js";

// The two first-party app factories this harness enables. Before enabling, the
// boot's `provisionAppModels` reads whatever Services each app declares
// (corpus/web both declare `services: ['reranker']`), resolves + loads the
// backing model, and publishes it on `RerankerCtx` — so the harness stays IO-free.
// Install more with `harness.dev install <app>` and add the factory here.
export const apps: AppFactory[] = [createCorpusApp, createWebApp];

const WEB_APP = "web";
const CORPUS_APP = "corpus";

/** Name → factory for the two first-party apps this build ships. Drives the
 *  `set_app_config` re-enable path (NOT config-write routing, which is
 *  name-driven by the command payload). Returns undefined for unknown names. */
const APP_FACTORIES: Record<string, AppFactory> = {
  [WEB_APP]: createWebApp,
  [CORPUS_APP]: createCorpusApp,
};
function factoryFor(name: string): AppFactory | undefined {
  return APP_FACTORIES[name];
}

/** Whether the named app's factory needs stored config to enable. The web app
 *  runs config-less (keyless search fallback); the corpus app needs a path. */
function appRequiresConfig(name: string): boolean {
  return name !== WEB_APP;
}

/** Resolve path-shaped string values in an app-config object at the UI→harness
 *  boundary — no per-app name knowledge. A value is a path when its key ends in
 *  "Path" or the string starts with ~ / . */
function resolveConfigPaths(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (
      typeof value === "string" &&
      value !== "" &&
      (/path$/i.test(key) || /^[~/.]/.test(value))
    ) {
      out[key] = resolvePath(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const MAX_TOOL_TURNS = 10;

// ── Planner context ──────────────────────────────────────────────

/** Summarize the registered apps for the planner prompt: the source catalog the
 *  planner routes against. With ≥2 sources the planner assigns each task's `app`
 *  to the source that holds it — grounded by the pre-flight coverage probe that
 *  runQuery folds into the context alongside this catalog. */
function buildPlannerContext(apps: readonly App[]): string {
  if (apps.length === 0) return "";
  const lines: string[] = [
    "Knowledge sources available for this research. Assign each task's `app` to the source that holds it, using its EXACT name below; the pre-flight `Source coverage` probe (when present) is the primary signal for which source covers what.",
  ];
  for (const app of apps) {
    const protocol = app.manifest.protocol;
    lines.push("", `### ${protocol.name}`, protocol.useWhen);
    const toc = app.source.promptData()["toc"];
    if (typeof toc === "string" && toc) {
      lines.push("Files and top-level topics available in this source:", toc);
    }
  }
  return lines.join("\n");
}

// ── Installed-AgentApps surfacing (Settings drawer) ──────────────
//
// Manifest-only (the app-catalog fetch was stripped from this template — no
// hardcoded apps.lloyal.ai URL in a scaffold, and the austere views have no
// Settings drawer). One descriptor per registry-ENABLED app, built from the
// app's OWN manifest. Display-only; forwarded to the renderer via `apps:state`.
// The catalog-metadata join (title/iconUrl/entitlements) reasoning.run does is
// intentionally absent here.

/** Build view-ready descriptors for every registry-enabled app, from each app's
 *  own manifest. Display-only — never throws on a missing field. */
function* buildAppDescriptors(
  registry: AppRegistry,
  configStore: AppConfigStore,
): Operation<AppDescriptor[]> {
  const descriptors: AppDescriptor[] = [];
  for (const app of registry.enabled()) {
    const manifest = app.manifest;
    const config = (yield* configStore.get(manifest.name)) ?? {};
    descriptors.push({
      name: manifest.name,
      title: manifest.hints?.shortName ?? manifest.protocol.name,
      description: manifest.hints?.description ?? manifest.protocol.useWhen,
      iconUrl: undefined,
      tools: [...manifest.protocol.tools],
      entitlements: [],
      configSchema: manifest.configSchema,
      config,
      enabled: true,
    });
  }
  return descriptors;
}

// ── Clarify helpers ──────────────────────────────────────────────

/** Render the planner's clarify questions as an assistant-style markdown message,
 *  committed to `session.trunk` paired with the user's input so subsequent planner
 *  forks attend over prior clarify rounds via KV inheritance. */
function formatClarifyAsAssistantMsg(questions: readonly string[]): string {
  return [
    "I need to clarify a few things before researching:",
    "",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
  ].join("\n");
}

// ── Error helpers ────────────────────────────────────────────────

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * A oneShot precondition/abort the harness can't proceed past (missing --query,
 * no source configured, a clarify it can't answer in non-TTY mode). Thrown rather
 * than `process.exit`ed so `harness` stays a pure `Operation<void>` — killing the
 * process is the runner's job. The boot catches it, writes `message`, and exits
 * `exitCode`; the Effection scope unwinds cleanly (teardowns run).
 */
class HarnessExit extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "HarnessExit";
  }
}

// ── harness — the Layer-3 entrypoint (platform contract) ─────────
//
// Runs INSIDE a runtime substrate the boot established (RerankerCtx via the
// boot's `provisionAppModels`, the agent contexts `initAgents` sets). It reads `RunnerCtx`
// for the edge-shell concerns it can't own. `events` is the UI `WorkflowEvent`
// bus; `agentEvents` (from `initAgents`) is the internal agent channel the
// forwarder relays into `events` + `RunDirSink`. Ends on Session close.

export function* harness(
  ctx: SessionContext,
  events: EventBus<WorkflowEvent>,
  commands: Signal<Command, void>,
): Operation<void> {
  const runner = yield* RunnerCtx.expect();
  const oneShot = runner.mode === "oneshot";

  // ── Session + event forwarding ─────────────────────────────
  const runDirSink = new RunDirSink();

  const { session, events: agentEvents } = yield* initAgents<WorkflowEvent>(ctx, {
    traceWriter: runner.traceWriter,
  });

  // Replay mode: rebuild the spine from the captured checkpoint and install it as
  // the session trunk BEFORE the apps register their listeners.
  if (runner.replayCheckpoint) {
    const replaySpine = yield* reconstructBranch(runner.replayCheckpoint);
    session.trunk = replaySpine;
  }

  // Spawned children of this iteration's scope auto-halt on return.
  yield* spawn(function* () {
    for (const ev of yield* each(agentEvents)) {
      runDirSink.handle(ev as WorkflowEvent);
      events.send(ev as WorkflowEvent);
      yield* each.next();
    }
  });

  // ── App registry ───────────────────────────────────────────
  // The reranker is already published on RerankerCtx by the boot's
  // `provisionAppModels` (before this harness runs), so the corpus/web factories
  // read it on enable. The registry owns each app's detached scope and tears them
  // down on scope exit. It also sets AppRegistryCtx, which the research pool reads
  // to render the spine and resolve per-spawn tool scope.
  yield* WindDown.set(runner.windDown);
  yield* CancelAgent.set(runner.cancelAgent);
  const configStore = createInMemoryConfigStore();
  // Seed the config store generically from the per-app config map — no app-name
  // knowledge. Each app's factory reads its own entry on enable.
  for (const [name, cfg] of Object.entries(runner.config().apps)) {
    yield* configStore.set(name, cfg);
  }
  const registry = yield* createAppRegistry({ configStore });

  // Per-boot preflight-coverage memo, spanning every command-loop iteration.
  yield* CoverageCacheCtx.set(yield* createCoverageCache());

  // The project's prompt-override dir, cwd-relative. Set ONLY when it exists — an
  // absent `prompts/` keeps the RACE/DRB-tuned baked defaults with no prompt-file
  // I/O (see resolvePrompt). Override a prompt by dropping `prompts/<name>.eta`.
  const promptsDir = path.join(process.cwd(), "prompts");
  if (fs.existsSync(promptsDir)) yield* PromptsCtx.set(promptsDir);

  // Enable the corpus app first so installed()[0] is corpus when present. It only
  // enables when the user has stored config for it (the factory needs a
  // corpusPath). A bad path surfaces a toast and leaves the app disabled.
  const corpusBootCfg = runner.config().apps[CORPUS_APP];
  if (corpusBootCfg && Object.keys(corpusBootCfg).length > 0) {
    events.send({ type: "weights:label", label: "Indexing corpus…" });
    try {
      const corpusApp = yield* registry.enable(createCorpusApp);
      const pdToc = corpusApp.source.promptData()["toc"];
      const pd = { toc: typeof pdToc === "string" ? pdToc : undefined };
      events.send({
        type: "corpus:indexed",
        corpusPath: String(corpusBootCfg.corpusPath ?? ""),
        fileCount: pd?.toc ? pd.toc.split("\n").filter(Boolean).length : 0,
        chunkCount: 0,
      });
    } catch (err) {
      events.send({
        type: "ui:error",
        message: `Corpus disabled: ${errorMessage(err)}. Use /scan to fix.`,
      });
    }
  }
  // Web is always available: createWebApp falls back to a keyless provider when no
  // tavilyKey is configured. Enable it unconditionally.
  try {
    yield* registry.enable(createWebApp);
  } catch (err) {
    events.send({
      type: "ui:error",
      message: `Web search disabled: ${errorMessage(err)}.`,
    });
  }

  // Surface the installed AgentApps into the renderer. Re-call after every
  // registry enable/disable/config change so the drawer stays in sync.
  function* emitApps(): Operation<void> {
    const apps = yield* buildAppDescriptors(registry, configStore);
    yield* agentEvents.send({ type: "apps:state", apps });
  }

  // Emit once boot completes (web/corpus enabled).
  yield* emitApps();

  events.send({ type: "weights:done" });
  events.send({ type: "ui:composer" });

  const harnessOpts = {
    maxTurns: MAX_TOOL_TURNS,
    findingsMaxChars: runner.findingsMaxChars,
    reasoningMode: runner.config().defaults.reasoningMode,
    effort: runner.config().defaults.effort,
  };

  function startRunDir(query: string, mode: "flat" | "deep"): void {
    const outputDir = runner.config().sources.outputDir ?? process.cwd();
    runDirSink.start({ outputDir, query, mode });
  }

  // ── JSONL / --query scripted path ──────────────────────────
  if (oneShot) {
    if (!runner.initialQuery) {
      throw new HarnessExit("Non-TTY mode requires --query.", 2);
    }
    if (registry.enabled().length === 0) {
      throw new HarnessExit(
        "No source configured. Enable an app in harness/harness.ts — the web app runs keyless.",
        2,
      );
    }
    const wallStartMs = performance.now();
    const result = yield* runQuery(runner.initialQuery, session, {
      ...harnessOpts,
      wallStartMs,
      onStart: () =>
        startRunDir(runner.initialQuery!, runner.config().defaults.reasoningMode),
    });
    if (result.type === "clarify") {
      throw new HarnessExit(
        "Planner asked clarifying questions; non-TTY mode can't answer. Aborting.",
        2,
      );
    }
    if (result.type === "research_plan") {
      startRunDir(runner.initialQuery, runner.config().defaults.reasoningMode);
      yield* runResearchPlan(runner.initialQuery, result.plan, session, {
        ...harnessOpts,
        wallStartMs,
      });
    }
    return;
  }

  // ── Ink TTY command loop ───────────────────────────────────

  // Per-query run effort, set at submit_query and read by every research path.
  let currentEffort: Effort = runner.config().defaults.effort;
  let pendingPlan: {
    plan: PlanResult;
    query: string;
    clarifyExchanged: boolean;
    mode: "flat" | "deep";
    wallStartMs: number;
    appFilter: readonly string[];
  } | null = null;

  // ── Run-in-fiber (Stop escape hatch) ───────────────────────
  // The heavy operations run in a CHILD fiber so the command loop keeps polling
  // `each(commands)` while a run is in flight. `stop` halts the held Task.
  let runTask: Task<void> | null = null;

  function* startRun(
    body: (clearIfCurrent: () => void) => Operation<void>,
  ): Operation<void> {
    if (runTask) yield* haltRun();
    const task = yield* spawn(() =>
      body(() => {
        if (runTask === task) runTask = null;
      }),
    );
    runTask = task;
  }

  function* haltRun(): Operation<void> {
    const task = runTask;
    runTask = null;
    if (!task) return;
    try {
      yield* task.halt();
    } catch {
      /* teardown-only error — the run is gone regardless */
    }
  }

  // Per-query App participation. Default: every enabled app is included.
  const participation: Record<string, boolean> = {};
  const seedParticipation = (): void => {
    for (const app of registry.enabled()) {
      if (participation[app.manifest.name] === undefined) {
        participation[app.manifest.name] = true;
      }
    }
  };
  const currentAppFilter = (): readonly string[] =>
    registry
      .enabled()
      .filter((a) => participation[a.manifest.name] !== false)
      .map((a) => a.manifest.name);
  seedParticipation();

  // Auto-submit --query only on the first iteration.
  if (runner.isFirstIteration && runner.initialQuery) {
    const mode = runner.config().defaults.reasoningMode;
    const wallStartMs = performance.now();
    const submissionFilter = currentAppFilter();
    const result = yield* runQuery(runner.initialQuery, session, {
      ...harnessOpts,
      reasoningMode: mode,
      wallStartMs,
      appFilter: submissionFilter,
      onStart: () => startRunDir(runner.initialQuery!, mode),
    });
    if (result.type === "research_plan") {
      pendingPlan = {
        plan: result.plan,
        query: runner.initialQuery,
        clarifyExchanged: false,
        mode,
        wallStartMs,
        appFilter: submissionFilter,
      };
      yield* agentEvents.send({ type: "ui:plan_review" });
    } else if (result.type === "clarify") {
      yield* call(() =>
        session.commitTurn(
          runner.initialQuery!,
          formatClarifyAsAssistantMsg(result.plan.clarifyQuestions),
        ),
      );
      pendingPlan = {
        plan: result.plan,
        query: runner.initialQuery,
        clarifyExchanged: false,
        mode,
        wallStartMs,
        appFilter: submissionFilter,
      };
    } else {
      yield* agentEvents.send({ type: "ui:composer" });
    }
  }

  for (const cmd of yield* each(commands)) {
    try {
      if (cmd.type === "quit") return;

      if (cmd.type === "stop") {
        if (runTask) {
          yield* haltRun();
          pendingPlan = null;
          yield* agentEvents.send({ type: "ui:composer" });
        }
        continue;
      }

      if (cmd.type === "wrap_up") {
        if (runTask) runner.windDown.send();
        continue;
      }

      if (cmd.type === "cancel_agent") {
        if (runTask) runner.cancelAgent.send({ agentId: cmd.agentId });
        continue;
      }

      if (cmd.type === "set_model_path") {
        runner.reloadRuntime({ model: { path: cmd.path } });
        return;
      }

      if (cmd.type === "set_reranker_path") {
        runner.reloadRuntime({ model: { reranker: cmd.path } });
        return;
      }

      if (cmd.type === "set_gpu") {
        runner.reloadRuntime({ model: { gpu: cmd.gpu } });
        return;
      }

      if (cmd.type === "toggle_participation") {
        const current = participation[cmd.name] ?? true;
        participation[cmd.name] = !current;
        yield* agentEvents.send({
          type: "participation:toggled",
          name: cmd.name,
        });
        continue;
      }

      if (cmd.type === "set_app_config") {
        const resolvedValues = resolveConfigPaths(cmd.values);
        const isClear = Object.keys(resolvedValues).length === 0;

        yield* configStore.set(cmd.name, resolvedValues);

        const factory = factoryFor(cmd.name);
        if (factory) {
          if (registry.byName(cmd.name)) yield* registry.disable(cmd.name);
          const needsConfig = appRequiresConfig(cmd.name);
          if (!isClear || !needsConfig) {
            try {
              const app = yield* registry.enable(factory);
              const pd = (
                app.source as { promptData?: () => { toc?: string } }
              ).promptData?.();
              if (pd?.toc !== undefined) {
                events.send({
                  type: "corpus:indexed",
                  corpusPath: String(resolvedValues.corpusPath ?? ""),
                  fileCount: pd.toc
                    ? pd.toc.split("\n").filter(Boolean).length
                    : 0,
                  chunkCount: 0,
                });
              }
            } catch (err) {
              yield* configStore.clear(cmd.name);
              yield* agentEvents.send({
                type: "ui:error",
                message: `Cannot configure ${cmd.name}: ${errorMessage(err)}`,
              });
              continue;
            }
          } else {
            yield* configStore.clear(cmd.name);
          }
        }

        participation[cmd.name] = true;

        const saved = runner.saveConfig({
          apps: { [cmd.name]: resolvedValues },
        });
        yield* agentEvents.send({
          type: "config:updated",
          config: saved.config,
          origin: saved.origin,
          savedTo: saved.path,
          gitignored: saved.gitignored,
          skipped: saved.skipped,
        });
        yield* emitApps();
      } else if (cmd.type === "set_output_dir") {
        const resolved = cmd.path ? resolvePath(cmd.path) : "";
        const saved = runner.saveConfig({
          sources: { outputDir: resolved },
        });
        yield* agentEvents.send({
          type: "config:updated",
          config: saved.config,
          origin: saved.origin,
          savedTo: saved.path,
          gitignored: saved.gitignored,
          skipped: saved.skipped,
        });
      } else if (cmd.type === "set_effort") {
        const saved = runner.saveConfig({
          defaults: { ...runner.config().defaults, effort: cmd.effort },
        });
        yield* agentEvents.send({
          type: "config:updated",
          config: saved.config,
          origin: saved.origin,
          savedTo: saved.path,
          gitignored: saved.gitignored,
          skipped: saved.skipped,
        });
      } else if (cmd.type === "submit_query") {
        if (registry.enabled().length === 0) {
          yield* agentEvents.send({
            type: "ui:error",
            message: "No source configured. Add Tavily key or corpus path.",
          });
          continue;
        }
        if (currentAppFilter().length === 0) {
          yield* agentEvents.send({
            type: "ui:error",
            message:
              "All sources excluded. Tab to a chip and press Space to include at least one.",
          });
          continue;
        }
        const wallStartMs = performance.now();
        currentEffort = runner.config().defaults.effort;
        if (runTask) {
          yield* haltRun();
          pendingPlan = null;
        }
        if (cmd.skipPlanner) {
          const plan = singleTaskPlan(cmd.query);
          yield* agentEvents.send({
            type: "plan:start",
            query: cmd.query,
            mode: cmd.mode,
          });
          yield* agentEvents.send({
            type: "query",
            query: cmd.query,
            warm: !!session.trunk,
          });
          yield* agentEvents.send({
            type: "plan",
            intent: plan.intent,
            tasks: plan.tasks,
            clarifyQuestions: plan.clarifyQuestions,
            tokenCount: plan.tokenCount,
            timeMs: plan.timeMs,
          });
          const submissionFilter = currentAppFilter();
          startRunDir(cmd.query, cmd.mode);
          yield* startRun(function* (clearIfCurrent) {
            try {
              yield* runResearchPlan(cmd.query, plan, session, {
                ...harnessOpts,
                reasoningMode: cmd.mode,
                effort: currentEffort,
                wallStartMs,
                appFilter: submissionFilter,
                isAsk: cmd.skipPlanner,
              });
              yield* agentEvents.send({ type: "ui:composer" });
            } catch (err) {
              yield* agentEvents.send({
                type: "ui:error",
                message: errorMessage(err),
              });
            } finally {
              clearIfCurrent();
            }
          });
          continue;
        }
        const submissionFilter = currentAppFilter();
        const queryText = cmd.query;
        const queryMode = cmd.mode;
        yield* startRun(function* (clearIfCurrent) {
          try {
            const result = yield* runQuery(queryText, session, {
              ...harnessOpts,
              reasoningMode: queryMode,
              effort: currentEffort,
              context: buildPlannerContext(registry.enabled()),
              wallStartMs,
              appFilter: submissionFilter,
              onStart: () => startRunDir(queryText, queryMode),
            });
            if (result.type === "research_plan") {
              pendingPlan = {
                plan: result.plan,
                query: queryText,
                clarifyExchanged: false,
                mode: queryMode,
                wallStartMs,
                appFilter: submissionFilter,
              };
              yield* agentEvents.send({ type: "ui:plan_review" });
            } else if (result.type === "clarify") {
              yield* call(() =>
                session.commitTurn(
                  queryText,
                  formatClarifyAsAssistantMsg(result.plan.clarifyQuestions),
                ),
              );
              pendingPlan = {
                plan: result.plan,
                query: queryText,
                clarifyExchanged: false,
                mode: queryMode,
                wallStartMs,
                appFilter: submissionFilter,
              };
            } else {
              yield* agentEvents.send({ type: "ui:composer" });
            }
          } catch (err) {
            pendingPlan = null;
            yield* agentEvents.send({
              type: "ui:error",
              message: errorMessage(err),
            });
          } finally {
            clearIfCurrent();
          }
        });
      } else if (cmd.type === "submit_clarification" && pendingPlan) {
        const { query: origQuery, mode, wallStartMs, appFilter } = pendingPlan;
        const priorPlan = pendingPlan;
        yield* call(() => session.prefillUser(cmd.answer));
        yield* startRun(function* (clearIfCurrent) {
          try {
            const result = yield* runQuery(origQuery, session, {
              ...harnessOpts,
              reasoningMode: mode,
              effort: currentEffort,
              context: buildPlannerContext(registry.enabled()),
              wallStartMs,
              appFilter,
              onStart: () => startRunDir(origQuery, mode),
            });
            if (result.type === "research_plan") {
              pendingPlan = {
                ...priorPlan,
                plan: result.plan,
                clarifyExchanged: true,
              };
              yield* agentEvents.send({ type: "ui:plan_review" });
            } else if (result.type === "clarify") {
              yield* call(() =>
                session.prefillAssistant(
                  formatClarifyAsAssistantMsg(result.plan.clarifyQuestions),
                ),
              );
              pendingPlan = {
                ...priorPlan,
                plan: result.plan,
                clarifyExchanged: true,
              };
            } else {
              pendingPlan = null;
              yield* agentEvents.send({ type: "ui:composer" });
            }
          } catch (err) {
            pendingPlan = null;
            yield* agentEvents.send({
              type: "ui:error",
              message: errorMessage(err),
            });
          } finally {
            clearIfCurrent();
          }
        });
      } else if (cmd.type === "change_mode" && pendingPlan) {
        const priorPlan = pendingPlan;
        const nextMode = cmd.mode;
        yield* startRun(function* (clearIfCurrent) {
          try {
            const result = yield* runQuery(priorPlan.query, session, {
              ...harnessOpts,
              reasoningMode: nextMode,
              effort: currentEffort,
              context: buildPlannerContext(registry.enabled()),
              wallStartMs: priorPlan.wallStartMs,
              appFilter: priorPlan.appFilter,
              onStart: () => startRunDir(priorPlan.query, nextMode),
            });
            if (result.type === "research_plan") {
              pendingPlan = { ...priorPlan, plan: result.plan, mode: nextMode };
              yield* agentEvents.send({ type: "ui:plan_review" });
            } else if (result.type === "clarify") {
              pendingPlan = { ...priorPlan, plan: result.plan, mode: nextMode };
            } else {
              pendingPlan = null;
              yield* agentEvents.send({ type: "ui:composer" });
            }
          } catch (err) {
            pendingPlan = null;
            yield* agentEvents.send({
              type: "ui:error",
              message: errorMessage(err),
            });
          } finally {
            clearIfCurrent();
          }
        });
      } else if (cmd.type === "accept_plan" && pendingPlan) {
        if (pendingPlan.plan.intent === "clarify") {
          pendingPlan = null;
          yield* agentEvents.send({ type: "ui:composer" });
          continue;
        }
        if (registry.enabled().length === 0) {
          yield* agentEvents.send({
            type: "ui:error",
            message: "No source configured. Add Tavily key or corpus path.",
          });
          pendingPlan = null;
          continue;
        }
        startRunDir(pendingPlan.query, pendingPlan.mode);
        const acceptedPlan = pendingPlan;
        pendingPlan = null;
        yield* startRun(function* (clearIfCurrent) {
          try {
            yield* runResearchPlan(
              acceptedPlan.query,
              acceptedPlan.plan,
              session,
              {
                ...harnessOpts,
                reasoningMode: acceptedPlan.mode,
                effort: currentEffort,
                wallStartMs: acceptedPlan.wallStartMs,
                appFilter: acceptedPlan.appFilter,
                userSidePending: acceptedPlan.clarifyExchanged,
              },
            );
            yield* agentEvents.send({ type: "ui:composer" });
          } catch (err) {
            yield* agentEvents.send({
              type: "ui:error",
              message: errorMessage(err),
            });
          } finally {
            clearIfCurrent();
          }
        });
      } else if (cmd.type === "cancel_plan") {
        pendingPlan = null;
        yield* agentEvents.send({ type: "ui:composer" });
      } else if (cmd.type === "edit_plan") {
        pendingPlan = null;
        yield* agentEvents.send({ type: "ui:composer", prefill: cmd.query });
      } else if (cmd.type === "update_task_description" && pendingPlan) {
        pendingPlan.plan.tasks = pendingPlan.plan.tasks.map((t, i) =>
          i === cmd.index ? { ...t, description: cmd.description } : t,
        );
        yield* agentEvents.send({
          type: "plan:task_updated",
          index: cmd.index,
          description: cmd.description,
        });
      } else if (cmd.type === "add_task" && pendingPlan) {
        const insertAt = Math.max(
          0,
          Math.min(pendingPlan.plan.tasks.length, cmd.afterIndex + 1),
        );
        pendingPlan.plan.tasks = [
          ...pendingPlan.plan.tasks.slice(0, insertAt),
          { description: "" },
          ...pendingPlan.plan.tasks.slice(insertAt),
        ];
        yield* agentEvents.send({
          type: "plan:task_added",
          afterIndex: cmd.afterIndex,
        });
      } else if (cmd.type === "delete_task" && pendingPlan) {
        if (pendingPlan.plan.tasks.length > 1) {
          pendingPlan.plan.tasks = pendingPlan.plan.tasks.filter(
            (_, i) => i !== cmd.index,
          );
          yield* agentEvents.send({
            type: "plan:task_deleted",
            index: cmd.index,
          });
        }
      } else if (cmd.type === "move_task" && pendingPlan) {
        const n = pendingPlan.plan.tasks.length;
        if (
          cmd.from !== cmd.to &&
          cmd.from >= 0 &&
          cmd.from < n &&
          cmd.to >= 0 &&
          cmd.to < n
        ) {
          const tasks = [...pendingPlan.plan.tasks];
          const [moved] = tasks.splice(cmd.from, 1);
          tasks.splice(cmd.to, 0, moved);
          pendingPlan.plan.tasks = tasks;
          yield* agentEvents.send({
            type: "plan:task_moved",
            from: cmd.from,
            to: cmd.to,
          });
        }
      }
    } catch (err) {
      pendingPlan = null;
      yield* agentEvents.send({ type: "ui:error", message: errorMessage(err) });
    } finally {
      yield* each.next();
    }
  }
  return;
}
