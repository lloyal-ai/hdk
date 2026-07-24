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
 * `blank` is deliberately the floor: two agents research a query in parallel
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
 *  these (an LLM planner, a routing rule, a workflow); blank keeps them static
 *  so the file reads top-to-bottom. Grow this into whatever your domain needs. */
const ANGLES = [
  "Gather the core facts, dates, and definitions.",
  "Gather context, significance, and differing viewpoints.",
];

const SYNTH_SYSTEM =
  "You combine several research notes into one clear, accurate answer. " +
  "Quote sources where the notes do. No preamble.";
const SYNTH_USER =
  "Question: <%= it.query %>\n\nResearch notes:\n<%= it.notes %>\n\nWrite the answer.";

/**
 * The one place blank subclasses `AgentPolicy`. A pool consults ONE policy per
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
  // Agent runtime over the resident model. `agentEvents` is the pool's own
  // channel — forward it to the surface so every spawn / token / return streams
  // live into the renderer. The spawned fiber auto-halts when this scope ends.
  const { session, events: agentEvents } = yield* initAgents<WorkflowEvent>(ctx);
  yield* spawn(function* () {
    for (const ev of yield* each(agentEvents)) {
      events.send(ev as WorkflowEvent);
      yield* each.next();
    }
  });

  // Compose your AgentApps. Wikipedia needs no reranker, config, or auth, so the
  // config store stays empty. The boot has already provisioned any model these
  // apps declare (see `apps` above); here we just enable each one.
  const registry = yield* createAppRegistry({
    configStore: createInMemoryConfigStore(),
  });
  for (const app of apps) yield* registry.enable(app);

  events.send({ type: "ready" });

  // The command loop. Ends on `quit` (or when the Session closes and the scope
  // unwinds). Everything the surface can ask for is a member of `Command`.
  for (const cmd of yield* each(commands)) {
    if (cmd.type === "quit") return;
    if (cmd.type === "submit_query") {
      try {
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

  // Synth: one agent, no tools, combines the notes. Committed to the session
  // trunk so a follow-up query can build on it.
  const synth = yield* useAgent({
    systemPrompt: SYNTH_SYSTEM,
    task: renderTemplate(SYNTH_USER, {
      query,
      notes: notes.map((n, i) => `[${i + 1}] ${n}`).join("\n\n"),
    }),
    parent: session.trunk ?? undefined,
    policy: new SynthPolicy(),
    maxTurns: MAX_TURNS,
  });

  const answer = synth.result?.trim() || notes.join("\n\n");
  yield* call(() => session.commitTurn(query, answer));
  return answer;
}
