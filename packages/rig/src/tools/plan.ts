import type { Operation } from 'effection';
import { Tool, agent, renderTemplate } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, App } from '@lloyal-labs/lloyal-agents';
import { Session } from '@lloyal-labs/sdk';

/**
 * Configuration for {@link PlanTool}.
 *
 * @category Rig
 */
export interface PlanToolOpts {
  /** System prompt + user template. User template is rendered via Eta with `{ query, count, context? }`. */
  prompt: { system: string; user: string };
  /** Active session whose trunk is used as the parent branch for generation. */
  session: Session;
  /** Maximum number of research tasks the planner may produce. Caps the
   *  `tasks` array via grammar `maxItems` and renders into the planner
   *  prompt as `it.count` so the model sees the limit. Does NOT bound
   *  `clarifyQuestions` (the planner prompt limits those by instruction only;
   *  add a separate cap if grammar-enforced bound is needed). */
  maxTasks: number;
  /** Sampling temperature for plan generation. @default 0.3 */
  temperature?: number;
  /**
   * Apps available to route research tasks to. When provided
   * and non-empty, the plan grammar constrains each task's `app` field to
   * an enum of these apps' `manifest.protocol.name` values — the names
   * the planner sees in the spine catalog — so the planner must assign
   * every task to a real protocol. The harness maps each emitted
   * `task.app` (a protocol name) back to its `manifest.name` to set
   * `SpawnSpec.assignedApp` when spawning research agents.
   *
   * Omit for single-app or app-agnostic pipelines: the grammar drops the
   * `app` field entirely and {@link ResearchTask.app} stays undefined.
   */
  availableApps?: readonly App[];
}

/**
 * A structured research task produced by the planner.
 *
 * Intent is a plan-level decision (see {@link PlanIntent}), not a per-task
 * attribute — a task is always a research assignment when emitted.
 *
 * @category Rig
 */
export interface ResearchTask {
  /** What to find out — a specific, actionable research assignment. */
  description: string;
  /**
   * Contract name of the app this task is routed to (matches one of the
   * planner's `availableApps`' `manifest.protocol.name`). Present only
   * when the planner ran with {@link PlanToolOpts.availableApps}; the
   * harness maps it to the App's `manifest.name` for
   * `SpawnSpec.assignedApp`. Undefined for single-app / app-agnostic
   * pipelines.
   */
  app?: string;
}

/**
 * Convert a ResearchTask to agent content string.
 *
 * @category Rig
 */
export function taskToContent(task: ResearchTask): string {
  return task.description;
}

/**
 * Parse the planner's JSON, tolerant of a markdown code fence or surrounding
 * prose. Grammar-constrained generation *should* emit bare JSON, but instruct
 * models routinely wrap it in ```json … ``` — the few-shot examples in the plan
 * prompt prime exactly that. A bare `JSON.parse` throws on the fence, which used
 * to silently demote a real research plan to passthrough (no plan presented for
 * approval), so extract the outermost `{…}` object before parsing.
 */
function parsePlanJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('planner output contained no JSON object');
    }
    return JSON.parse(raw.slice(start, end + 1));
  }
}

/**
 * Plan-level disposition for the user's query.
 *
 * - **clarify** — query is genuinely ambiguous; planner emits `clarifyQuestions`,
 *   harness returns to REPL for user input.
 * - **passthrough** — query is a follow-up answerable from session.trunk's prior
 *   Q&A turns; harness skips research pipeline, streams answer from trunk, commits turn.
 * - **research** — query needs full decomposition; planner emits `tasks`, harness
 *   runs the chain → synth → verify pipeline.
 *
 * @category Rig
 */
export type PlanIntent = 'clarify' | 'passthrough' | 'research';

/**
 * Output returned by {@link PlanTool} execution.
 *
 * @category Rig
 */
export interface PlanResult {
  /** Plan-level disposition: how should the harness route this query? */
  intent: PlanIntent;
  /** Research tasks (non-empty when intent === 'research'; empty otherwise). */
  tasks: ResearchTask[];
  /** Clarification questions for the user (non-empty when intent === 'clarify'; empty otherwise). */
  clarifyQuestions: string[];
  /** Number of tokens generated during planning. */
  tokenCount: number;
  /** Wall-clock time for the planning pass in milliseconds. */
  timeMs: number;
}

/**
 * Grammar-constrained query planner.
 *
 * Analyzes the user's query (with prior conversation in KV via warm session fork)
 * and produces a {@link PlanResult} that commits to one disposition: clarify /
 * passthrough / research. Uses a JSON grammar to guarantee structured output;
 * the planner must choose one of the three intents and populate the matching
 * fields (tasks for research, clarifyQuestions for clarify, neither for passthrough).
 *
 * @category Rig
 */
export class PlanTool extends Tool<{ query: string; context?: string }> {
  readonly name = 'plan';
  readonly description = 'Analyze a user query and decide how to handle it: ask for clarification, pass through for direct answer from conversation history, or decompose into research tasks.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The research query to analyze' },
      context: { type: 'string', description: 'Optional context from prior clarification' },
    },
    required: ['query'],
  };

  private _prompt: { system: string; user: string };
  private _session: Session;
  private _maxTasks: number;
  private _temperature: number;
  private _appProtocolNames: string[];

  constructor(opts: PlanToolOpts) {
    super();
    this._prompt = opts.prompt;
    this._temperature = opts.temperature ?? 0.3;
    this._session = opts.session;
    this._maxTasks = opts.maxTasks;
    this._appProtocolNames = (opts.availableApps ?? []).map(a => a.manifest.protocol.name);
  }

  *execute(args: { query: string; context?: string }): Operation<unknown> {
    const t = performance.now();

    // When apps are available, force the planner to route every task to
    // one of their protocol names via a grammar enum. With no
    // apps the task carries only a description.
    const hasApps = this._appProtocolNames.length > 0;
    const taskProperties: Record<string, JsonSchema> = {
      description: { type: 'string' },
    };
    const taskRequired = ['description'];
    if (hasApps) {
      taskProperties.app = { type: 'string', enum: this._appProtocolNames };
      taskRequired.push('app');
    }

    const schema: JsonSchema = {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['clarify', 'passthrough', 'research'] },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: taskProperties,
            required: taskRequired,
          },
          maxItems: this._maxTasks,
        },
        clarifyQuestions: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['intent'],
    };

    const userContent = renderTemplate(this._prompt.user, {
      query: args.query,
      count: this._maxTasks,
      context: args.context || null,
    });

    const planAgent = yield* agent({
      systemPrompt: this._prompt.system,
      task: userContent,
      schema,
      params: { temperature: this._temperature },
      session: this._session,
      // The planner is a grammar-constrained JSON decision over a warm
      // conversational trunk (clarify history). Thinking-on makes the model
      // open a <think> block and re-reason the query from scratch — re-asking
      // already-answered clarifications instead of attending to the prior
      // turns. Force it off so the schema-constrained decision reads the trunk.
      enableThinking: false,
    });

    const timeMs = performance.now() - t;
    const tokenCount = planAgent.tokenCount;

    try {
      const parsed = parsePlanJson(planAgent.rawOutput) as {
        intent?: string;
        tasks?: { description?: string; app?: string }[];
        clarifyQuestions?: string[];
      };

      const intent: PlanIntent =
        parsed.intent === 'clarify' || parsed.intent === 'passthrough' || parsed.intent === 'research'
          ? parsed.intent
          : 'research';

      const tasks: ResearchTask[] = (parsed.tasks ?? [])
        .slice(0, this._maxTasks)
        .filter(t => typeof t.description === 'string')
        .map(t => (typeof t.app === 'string'
          ? { description: t.description!, app: t.app }
          : { description: t.description! }));

      const clarifyQuestions = (parsed.clarifyQuestions ?? []).filter(q => typeof q === 'string');

      return { intent, tasks, clarifyQuestions, tokenCount, timeMs } satisfies PlanResult;
    } catch {
      // Grammar should prevent this; fall through to passthrough on malformed output
      // so the harness routes to a direct trunk-stream answer rather than running a
      // research pipeline with no real plan.
      return {
        intent: 'passthrough',
        tasks: [],
        clarifyQuestions: [],
        tokenCount,
        timeMs,
      } satisfies PlanResult;
    }
  }
}
