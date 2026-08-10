/**
 * Your harness — the one file that's genuinely yours.
 *
 * It IS the platform contract: a headless generator `harness(ctx, events,
 * commands)`. `ctx` is the resident model; `events` streams your
 * `WorkflowEvent`s to whatever surface is mounted (terminal / Electron /
 * browser); `commands` delivers that surface's `Command`s back. The runtime,
 * the bindings, the targets, and the trust plumbing are conventions handled
 * for you — this file is where you program what your intelligence does.
 *
 * `basic` is deliberately the floor: two agents research a query in parallel
 * over a shared spine, a synth agent combines their notes. That's the whole
 * grammar in miniature — topology (`parallel`), a shared spine (`withSpine`),
 * a terminal tool (`report`), a reduce step (the synth). Replace it with your
 * own program; nothing else in the project needs to know what you wrote here.
 */
import { spawn, each, call } from "effection";
import type { Operation, Signal } from "effection";
import type { EventBus } from "@lloyal-labs/binding";
import type { Session, SessionContext } from "@lloyal-labs/sdk";
import {
  initAgents,
  agentPool,
  useAgent,
  parallel,
  withSpine,
  renderTemplate,
  DefaultAgentPolicy,
  AppRegistryCtx,
  WindDown,
  CancelAgent,
} from "@lloyal-labs/lloyal-agents";
import type { App, AppFactory, AgentRenderCtx } from "@lloyal-labs/lloyal-agents";
import {
  createAppRegistry,
  createInMemoryConfigStore,
  reportTool,
  renderSpine,
  renderAgentPreamble,
} from "@lloyal-labs/rig";
import { createWikipediaApp } from "@lloyal-labs/wikipedia-app";
import { RunnerCtx } from "./runner-ctx.js";
import { reportBody } from "./state.js";
import type { Command, WorkflowEvent } from "./protocol.js";

/**
 * The AgentApps this harness enables. Before enabling, the boot provisions
 * whatever models each app declares (wikipedia needs nothing; corpus/web need a
 * reranker) — so add an installed app's factory here and the model it needs is
 * fetched for you. Install more with `harness.dev install <app>`.
 */
export const apps: AppFactory[] = [createWikipediaApp];

const MAX_TURNS = 8;

/** The whole "plan": two fixed research angles. A real harness would *compute*
 *  these (an LLM planner, a routing rule, a workflow); basic keeps them static
 *  so the file reads top-to-bottom. Grow this into whatever your domain needs. */
const ANGLES = [
  "Gather the core facts, dates, and definitions.",
  "Gather context, significance, and differing viewpoints.",
];

// The synth prompt is where "note-dump" becomes "report". These few lines are a
// trimmed distillation of the RACE/DRB-tuned report discipline: commit to a
// thesis, structure by argument, ground every claim, cite inline. `research`
// ships the full benchmark-tuned versions as editable `.eta` files; basic keeps
// it inline (plain-`tsc` build) — edit it to shape how your intelligence writes.
const SYNTH_SYSTEM = [
  "You are a research synthesist. You are given several numbered research notes and",
  "must write ONE grounded markdown report that answers the question. Rules:",
  "",
  "- Open with a single-sentence **thesis** that directly answers the question — not a",
  "  restatement of the question, not a list of findings.",
  "- Structure the body into `##` sections named by their role in the argument (e.g.",
  '  "## What the sources establish", "## Where they disagree", "## What follows") —',
  "  never by note number or by source.",
  "- Write fluent prose. Use a bulleted list only for genuinely parallel items.",
  "- Ground every claim in the notes. Cite inline as [short title](url) using the exact",
  "  URLs that appear in the notes, placed right at the claim each supports.",
  "- Never invent a source, URL, or fact the notes don't contain. If the notes are thin,",
  "  say so in a sentence rather than padding.",
  "- End with a short `## Bottom line`. Do NOT append a Sources list — the interface",
  "  shows the sources separately.",
  "",
  "Output the markdown report directly — no preamble, no tool call.",
].join("\n");
const SYNTH_USER = [
  "Question: <%= it.query %>",
  "",
  "Research notes (cite by the URLs inside them):",
  "<%= it.notes %>",
  "",
  "Write the grounded markdown report.",
].join("\n");

// The follow-up variants. A second question DEEPENS the same article rather than
// starting a new one — each turn is another pass over one accreting page.
//
// Nothing re-sends the article: synth forks `session.trunk`, and `commitTurn`
// put the previous turn there, so the current article is already in this agent's
// KV prefix. These prompts only point at it. Re-injecting it as text would pay
// for the same tokens twice and grow with every turn.
const SYNTH_EXTEND_SYSTEM = [
  "You are extending an existing research article. The current article is above this",
  "message — it is the assistant side of the previous exchange. New research notes",
  "for a follow-up question are below. Rules:",
  "",
  "- Output the COMPLETE updated article, not a diff and not just the new part.",
  "- Preserve the existing sections and their inline citations. Change a claim only",
  "  where the new notes actually correct it.",
  "- Fold the new material into the section where it belongs. Add a new `##` section",
  "  only for genuinely new ground the article does not yet cover.",
  "- The result is ONE article about the whole subject, not two reports stitched",
  "  together. A reader arriving fresh should not be able to tell where one turn",
  "  ended and the next began.",
  "- Keep the opening thesis accurate for the article as it now stands, and update",
  "  `## Bottom line` to cover the whole page rather than only the latest question.",
  "- Same grounding rules as before: cite inline as [short title](url) using exact",
  "  URLs from the notes, and never invent a source, URL, or fact.",
  "",
  "Output the markdown article directly — no preamble, no tool call.",
].join("\n");
const SYNTH_EXTEND_USER = [
  "Follow-up question: <%= it.query %>",
  "",
  "New research notes (cite by the URLs inside them):",
  "<%= it.notes %>",
  "",
  "Extend the article above to cover this as well, and output the complete article.",
].join("\n");

/** Synthesis has two modes: open a page, or deepen the one already written. */
const SYNTH = {
  fresh: { system: SYNTH_SYSTEM, user: SYNTH_USER },
  deepen: { system: SYNTH_EXTEND_SYSTEM, user: SYNTH_EXTEND_USER },
} as const;

/**
 * The one place basic subclasses `AgentPolicy`. A pool consults ONE policy per
 * role; the synth agent has no tools, so its free text IS the result — but the
 * default policy gates a free-text return behind ≥1 tool call. This overrides
 * that single hook. (Every other decision uses the stock `DefaultAgentPolicy`.)
 */
class SynthPolicy extends DefaultAgentPolicy {
  override onProduced(
    ...args: Parameters<DefaultAgentPolicy["onProduced"]>
  ): ReturnType<DefaultAgentPolicy["onProduced"]> {
    const [, parsed] = args;
    if (!parsed.toolCalls[0] && parsed.content) {
      return { type: "free_text_return", content: parsed.content };
    }
    return super.onProduced(...args);
  }
}

export function* harness(
  ctx: SessionContext,
  events: EventBus<WorkflowEvent>,
  commands: Signal<Command, void>,
): Operation<void> {
  // The Runner — your harness's edge substrate (the boot set it on RunnerCtx
  // before calling us). It carries the live config, the observability trace sink,
  // and the persistent wind-down / cancel signals. Reading it here is the ONE
  // platform contract every harness shares — the reference `research` template
  // reads the exact same shape, so growing into config persistence or tracing
  // never means migrating to a different seam.
  const runner = yield* RunnerCtx.expect();

  // Agent runtime over the resident model, threading the Runner's trace sink so
  // an observability run captures every spawn / token. `agentEvents` is the pool's
  // own channel — forward it to the surface so every spawn / token / return
  // streams live into the renderer. The spawned fiber auto-halts when this scope
  // ends.
  const { session, events: agentEvents } = yield* initAgents<WorkflowEvent>(ctx, {
    traceWriter: runner.traceWriter,
  });
  yield* spawn(function* () {
    for (const ev of yield* each(agentEvents)) {
      events.send(ev as WorkflowEvent);
      yield* each.next();
    }
  });

  // Republish the Runner's persistent lifecycle signals so the framework's
  // graceful wind-down / per-agent cancel machinery can read them. basic's simple
  // command loop doesn't trigger them, but the seam is here for a pipeline that
  // grows a stop/cancel command (`runner.windDown.send()` / `runner.cancelAgent.send()`).
  yield* WindDown.set(runner.windDown);
  yield* CancelAgent.set(runner.cancelAgent);

  // Compose your AgentApps. Seed the config store from the Runner's live config so
  // each app reads its own entry on enable (empty for the default wikipedia — it
  // needs no reranker, config, or auth). The boot has already provisioned any
  // model these apps declare (see `apps` above); here we just enable each one.
  const configStore = createInMemoryConfigStore();
  for (const [name, cfg] of Object.entries(runner.config().apps)) {
    yield* configStore.set(name, cfg);
  }
  const registry = yield* createAppRegistry({ configStore });
  for (const app of apps) yield* registry.enable(app);

  // Boot done — announce it with MEASURED facts, not hardcoded strings: the
  // model's id + on-disk size (the boot stat'd the weight into the config), the
  // surface that mounted, and the apps actually enabled (read from the registry).
  // Every surface folds this one event, so the header is identical everywhere.
  const cfg = runner.config();
  events.send({
    type: "ready",
    facts: {
      model: { id: cfg.model.id ?? "model", sizeBytes: cfg.model.sizeBytes ?? 0 },
      surface: cfg.surface ?? "cli",
      apps: registry.enabled().map((a) => a.name),
    },
  });

  // The command loop. Ends on `quit` (or when the Session closes and the scope
  // unwinds). Everything the surface can ask for is a member of `Command`.
  for (const cmd of yield* each(commands)) {
    if (cmd.type === "quit") return;
    if (cmd.type === "submit_query") {
      try {
        // Announce the turn before any work. A warm trunk means this turn
        // deepens the article already on the page rather than starting one.
        events.send({ type: "query", text: cmd.query, warm: !!session.trunk });
        const answer = yield* runQuery(cmd.query, session, events);
        events.send({ type: "answer", text: answer });
      } catch (err) {
        events.send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    yield* each.next();
  }
}

/** Per-agent system prompt — renders the app's `skill.eta` with the render ctx. */
function agentPreamble(app: App, taskIndex: number): string {
  return renderAgentPreamble(app, {
    maxTurns: MAX_TURNS,
    agentCount: ANGLES.length,
    siblingTasks: [],
    date: new Date().toISOString().slice(0, 10),
    taskIndex,
  } as AgentRenderCtx & Record<string, unknown>);
}

function* runQuery(
  query: string,
  session: Session,
  _events: EventBus<WorkflowEvent>,
): Operation<string> {
  const registry = yield* AppRegistryCtx.expect();
  const apps = registry.enabled();
  if (apps.length === 0) {
    throw new Error(
      "No AgentApp is enabled — enable one in harness.ts (e.g. `yield* registry.enable(createWikipediaApp)`).",
    );
  }
  // Read BEFORE the turn is committed: a trunk here means an article already
  // exists, so this run deepens it instead of opening a new one.
  const mode = session.trunk ? "deepen" : "fresh";
  const tools = [...apps.flatMap((a) => [...a.tools]), reportTool];
  const spinePrompt = renderSpine({ apps });

  // Two agents, in parallel, over one shared spine. `report` is the terminal
  // tool; `pruneOnReturn` frees each agent's KV as it finishes.
  const notes = yield* withSpine<string[]>(
    { parent: session.trunk ?? undefined, systemPrompt: spinePrompt, tools },
    function* (spine) {
      const pool = yield* agentPool({
        tools,
        parent: spine,
        terminal: reportTool,
        maxTurns: MAX_TURNS,
        pruneOnReturn: true,
        policy: new DefaultAgentPolicy({ terminalToolName: "report" }),
        enableThinking: true,
        // Breadth: independent angles, in parallel, over one shared spine.
        // For sequential DEPTH — each task building on the last via the spine —
        // swap `parallel` for `chain(ANGLES, (angle, i) => ({ task: {...},
        // userContent: `…` }))` (import `chain` from `@lloyal-labs/lloyal-agents`).
        // The benchmark-tuned deep/flat research pipelines live in `research`.
        orchestrate: parallel(
          ANGLES.map((angle, i) => ({
            content: `${query}\n\nFocus: ${angle}`,
            systemPrompt: agentPreamble(apps[0], i),
            seed: 1000 + i,
          })),
        ),
      });
      return pool.agents
        .map((a) => a.result?.trim() ?? "")
        .filter((r): r is string => r.length > 0);
    },
  );

  if (notes.length === 0) {
    return "No findings — the research agents returned nothing.";
  }

  // Synth: one agent, no tools, combines the notes. It forks the trunk, which
  // already holds the article, so `deepen` can point at it rather than restate
  // it — the page grows turn by turn instead of being replaced by a new one.
  const synth = yield* useAgent({
    systemPrompt: SYNTH[mode].system,
    task: renderTemplate(SYNTH[mode].user, {
      query,
      notes: notes.map((n, i) => `[${i + 1}] ${n}`).join("\n\n"),
    }),
    parent: session.trunk ?? undefined,
    policy: new SynthPolicy(),
    maxTurns: MAX_TURNS,
  });

  // `reportBody` drops the model's `<think>` reasoning and any stray markup, so the
  // committed turn + the `answer` event carry the clean markdown report — not the
  // raw stream. (The live agent cards keep `<think>` via `cleanNarration`; the final
  // answer does not.)
  const answer = reportBody(synth.result ?? "") || notes.join("\n\n");

  // The page IS the state, so re-base the trunk on the article as it now stands
  // rather than appending another copy beside the drafts it supersedes. With no
  // trunk, `commitTurn` takes its cold path — fresh branch, prefill, promote —
  // and promote's `retainOnly` reclaims the old one. Append instead and the
  // trunk ends up holding every revision of the page.
  //
  // Restore on failure: until `promote` lands there is no new trunk, so leaving
  // it null would silently drop the article and open the NEXT question on a
  // blank page. Better to lose the turn than the page.
  const superseded = session.trunk;
  session.trunk = null;
  try {
    yield* call(() => session.commitTurn(query, answer));
  } catch (err) {
    session.trunk = superseded;
    throw err;
  }
  return answer;
}
