/**
 * Harness — turn a user query into an answer.
 *
 * Pipeline (parallel research → synth):
 *   1. PlanTool decomposes the query into N orthogonal research tasks.
 *   2. agentPool fans out N agents in parallel; each runs against the
 *      configured Apps' tools, terminating with `report`.
 *   3. A synth agent reduces the N reports into a single answer.
 *
 * The harness IS the orchestrator: it composes the SDK's `agentPool`,
 * `parallel`, `useAgent`, `withSpine`, and `reportTool` primitives. No
 * extra orchestrator agent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { call } from "effection";
import type { Operation } from "effection";
import type { Session } from "@lloyal-labs/sdk";
import {
  AppRegistryCtx,
  agentPool,
  useAgent,
  parallel,
  renderTemplate,
  withSpine,
  DefaultAgentPolicy,
} from "@lloyal-labs/lloyal-agents";
import type { App, AgentRenderCtx } from "@lloyal-labs/lloyal-agents";
import {
  reportTool,
  PlanTool,
  renderSpine,
  renderAgentPreamble,
  taskToContent,
} from "@lloyal-labs/rig";
import type { PlanResult, ResearchTask } from "@lloyal-labs/rig";

// Prompts are loaded from the `prompts/` directory at package root. After
// `tsc` the compiled module sits at `dist/harness.js`, so `__dirname` is
// `dist/` — go up one level to find the prompts.
const PROMPT_DIR = join(__dirname, "..", "prompts");
const PLAN_RAW = readFileSync(join(PROMPT_DIR, "plan.eta"), "utf8");
const SYNTH_RAW = readFileSync(join(PROMPT_DIR, "synth.eta"), "utf8");

function parsePrompt(raw: string): { system: string; user: string } {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf("\n---\n");
  if (sep === -1) return { system: trimmed, user: "" };
  return {
    system: trimmed.slice(0, sep).trim(),
    user: trimmed.slice(sep + 5).trim(),
  };
}

const PLAN = parsePrompt(PLAN_RAW);
const SYNTH = parsePrompt(SYNTH_RAW);

const MAX_TASKS = 4;
const MAX_TURNS_PER_AGENT = 10;

/**
 * Synth policy — synth has no tools. Its full output IS the answer, so
 * end-of-generation is the terminal signal. The base policy gates
 * `free_text_report` behind ≥1 tool call; synth bypasses that.
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

function createResearchPolicy(): DefaultAgentPolicy {
  return new DefaultAgentPolicy({
    budget: {
      context: { softLimit: 2048, hardLimit: 1024 },
      time: { softLimit: 240_000, hardLimit: 360_000 },
    },
    terminalToolName: "report",
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function appPreamble(app: App, ctx: AgentRenderCtx): string {
  const extra =
    (app.source as { promptData?: () => Record<string, unknown> }).promptData?.() ??
    {};
  return renderAgentPreamble(app, { ...ctx, ...extra });
}

/**
 * Run the planner LLM. Returns a structured plan with `tasks`.
 */
function* runPlanner(
  query: string,
  session: Session,
  apps: readonly App[],
): Operation<PlanResult> {
  const planTool = new PlanTool({
    prompt: PLAN,
    session,
    maxTasks: MAX_TASKS,
    availableApps: apps.length >= 2 ? apps : undefined,
  });
  return (yield* planTool.execute({
    query,
    context: `Today's date: ${today()}`,
  })) as PlanResult;
}

/**
 * Run a research query end-to-end. Plans, fans out research agents in
 * parallel under a shared spine, synthesizes the reports into a single
 * answer, and commits the (query, answer) pair to the session trunk.
 *
 * Single-task plans skip synth — the lone agent's report IS the answer.
 */
export function* runQuery(query: string, session: Session): Operation<string> {
  const registry = yield* AppRegistryCtx.expect();
  const apps = registry.enabled();
  if (apps.length === 0) {
    throw new Error(
      "runQuery: no apps enabled — register at least one app before running queries.",
    );
  }

  process.stdout.write("Planning...\n");
  const plan = yield* runPlanner(query, session, apps);
  if (plan.tasks.length === 0) {
    throw new Error("runQuery: planner returned an empty task list.");
  }
  process.stdout.write(`Plan: ${plan.tasks.length} task(s)\n`);
  for (const [i, t] of plan.tasks.entries()) {
    process.stdout.write(`  ${i + 1}. ${t.description}\n`);
  }
  process.stdout.write("\n");

  const primaryApp = apps[0];
  const byProtocol = new Map(apps.map((a) => [a.manifest.protocol.name, a]));
  const appForTask = (task: ResearchTask): App =>
    (task.app ? byProtocol.get(task.app) : undefined) ?? primaryApp;

  const researchTools = [...apps.flatMap((a) => [...a.tools]), reportTool];
  const spinePrompt = renderSpine({ apps });
  const currentDate = today();
  const tasks = plan.tasks;

  process.stdout.write("Researching...\n");
  const answer = yield* withSpine<string>(
    {
      parent: session.trunk ?? undefined,
      systemPrompt: spinePrompt,
      tools: researchTools,
    },
    function* (querySpine) {
      const research = yield* agentPool({
        tools: researchTools,
        parent: querySpine,
        terminal: reportTool,
        maxTurns: MAX_TURNS_PER_AGENT,
        pruneOnReturn: true,
        policy: createResearchPolicy(),
        enableThinking: true,
        orchestrate: parallel(
          tasks.map((task: ResearchTask, i: number) => {
            const app = appForTask(task);
            return {
              content: taskToContent(task),
              systemPrompt: appPreamble(app, {
                maxTurns: MAX_TURNS_PER_AGENT,
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
        ),
      });

      if (tasks.length === 1) {
        return research.agents[0]?.result?.trim() ?? "";
      }

      process.stdout.write("Synthesizing...\n");
      const findings = research.agents
        .map((a, i) => {
          const desc = tasks[i]?.description ?? `task ${i + 1}`;
          const body = a.result?.trim() || "(no findings)";
          return `### Agent ${i + 1}: ${desc}\n\n${body}`;
        })
        .join("\n\n");
      const synthCtx = { query, findings, agentCount: tasks.length };

      const synth = yield* useAgent({
        systemPrompt: renderTemplate(SYNTH.system, synthCtx),
        task: renderTemplate(SYNTH.user, synthCtx),
        parent: querySpine,
        policy: new SynthPolicy(),
        maxTurns: MAX_TURNS_PER_AGENT,
      });

      return synth.result || "";
    },
  );

  if (answer) {
    yield* call(() => session.commitTurn(query, answer));
  }
  return answer;
}
