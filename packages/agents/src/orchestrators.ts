import { all, spawn } from 'effection';
import type { Operation, Task } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import type { Agent } from './Agent';
import { SpawnRefused, outcomeOfAgent } from './spawns';
import type { SpawnOutcome } from './types';

/**
 * Spec for spawning a single agent under a {@link PoolContext}.
 * `parent` defaults to `ctx.spine`.
 *
 * @category Agents
 */
export interface SpawnSpec {
  /** User message content — the agent's task. */
  content: string;
  /** Per-agent system prompt. */
  systemPrompt: string;
  /** PRNG seed for sampler diversity. */
  seed?: number;
  /**
   * Agent ids whose completion gated this spawn — the DAG's dependency
   * edges, resolved at spawn time. The `ability`-label class: non-enforcing,
   * carried on `agent:spawn` for the trace and the dev pane only.
   */
  after?: number[];
  /** Parent branch to fork from. Falls back to ctx.spine. */
  parent?: Branch;
  /**
   * Non-enforcing label naming the Ability this spawn nominally belongs to
   * Carried for trace attribution (`tool:authReject`) and
   * harness UI only — tool access is gated by {@link Tool.protected} +
   * session grants (the authGuard), not by ability membership.
   */
  assignedAbility?: string;
  /**
   * The application's label for this spawn — a row, a task index — carried on
   * `agent:spawn` and read back through `AgentPoolResult.byKey`. Optional and
   * non-enforcing; refused when repeated within one pool.
   */
  key?: string;
}

/**
 * Orchestrator-facing API surface exposed by {@link useAgentPool}.
 *
 * The orchestrator drives task spawning, waiting, and spine extension
 * through this object. The pool's tick loop runs concurrently and batches
 * decode across whatever agents are currently active.
 *
 * @category Agents
 */
export interface PoolContext {
  /** The pool's spine branch. Orchestrator-provided spawns fork from here by default. */
  readonly spine: Branch;

  /**
   * Request an agent: priced now, forked and activated when the pool seats it
   * (KV, a vacant sequence, `capacity`), which may be several ticks later.
   * Throws {@link SpawnRefused} when it can never be seated.
   */
  spawn(spec: SpawnSpec): Operation<Agent>;

  /** Suspend until the spawn is final, across heals; returns the lineage's final agent — a replacement when there was one. */
  waitFor(agent: Agent): Operation<Agent>;

  /**
   * Serialize a user+assistant turn and prefill it into the spine, advancing spine.position.
   * No-op (returns 0) when assistantContent is empty. Admitted against headroom like
   * every other prefill: it waits for room while agents can still free KV, and throws
   * once nothing can — the spine is never handed a delta that does not fit.
   */
  extendSpine(userContent: string, assistantContent: string): Operation<number>;

  /** Whether another spawn with this suffix size would fit under current pressure. */
  canFit(estimatedSuffixTokens: number): boolean;
}

/**
 * An orchestrator is a generator that drives a pool via {@link PoolContext}.
 * Returned by the factory functions in this module.
 *
 * @category Agents
 */
export type Orchestrator = (ctx: PoolContext) => Operation<void>;

// ── Factories ──────────────────────────────────────────────────

/**
 * What {@link parallel} takes beside its specs.
 *
 * @category Agents
 */
export interface ParallelOptions {
  /**
   * Fires once per spec, as its spawn settles — the final outcome across heals,
   * a refused spawn included as a failed outcome carrying the pool's reason.
   * The hook `ChainStep.beforeSpawn` and `afterExtend` already are: a caller
   * instruments each item without dropping down to an inline orchestrator.
   */
  afterDone?: (index: number, outcome: SpawnOutcome) => Operation<void>;
}

/**
 * Parallel orchestrator — every task requested at once, all siblings off the
 * spine; the pool seats them as it can, so a wide list runs in waves. A spawn
 * the pool refuses is one failed outcome, not the end of its siblings.
 *
 * @example
 * ```ts
 * yield* agentPool({
 *   tools: [...],
 *   orchestrate: parallel(questions.map(q => ({ content: q, systemPrompt: WORKER }))),
 * });
 * ```
 *
 * @category Agents
 */
export const parallel = (tasks: SpawnSpec[], opts: ParallelOptions = {}): Orchestrator =>
  function* (ctx) {
    yield* all(tasks.map((t, i) => (function* (): Operation<void> {
      let agent: Agent;
      try {
        agent = yield* ctx.spawn({ ...t, parent: t.parent ?? ctx.spine });
      } catch (e) {
        if (!(e instanceof SpawnRefused)) throw e;
        if (opts.afterDone) yield* opts.afterDone(i, e.outcome);
        return;
      }
      const final = yield* ctx.waitFor(agent);
      if (opts.afterDone) yield* opts.afterDone(i, outcomeOfAgent(final, t.key));
    })()));
  };

/**
 * One step of a {@link chain} orchestrator. Declares the task, optional user
 * content for spine extension after the task reports, and optional observability
 * hooks that fire before the spawn and after the spine extension.
 *
 * The hooks let harnesses emit streaming events (per-task progress, completion
 * telemetry) without dropping down to an inline orchestrator — the factory
 * stays declarative while the hook bodies stay co-located with the step they
 * instrument.
 *
 * @category Agents
 */
export interface ChainStep {
  task: SpawnSpec;
  /** User content recorded on the spine — the step's task, as the spine will remember it. Omit to skip extension. */
  userContent?: string;
  /** Fires BEFORE `ctx.spawn` for this step. Use for "task starting" events. */
  beforeSpawn?: () => Operation<void>;
  /**
   * Fires AFTER `ctx.extendSpine` for this step (or immediately after waitFor
   * if no extension happened). Receives the number of tokens added to the
   * spine (0 when no extension) and the root's position after any extension.
   * Use for "task done" events with spine telemetry.
   */
  afterExtend?: (delta: number, position: number) => Operation<void>;
}

/**
 * Chain orchestrator — sequential execution. Each step may extend the shared
 * root with its findings before the next step forks from the extended position.
 *
 * The second argument maps each item to a ChainStep, so callers can compute
 * per-task prompts and spine labels from their own data model without
 * coupling the factory to a particular task type.
 *
 * @example
 * ```ts
 * yield* agentPool({
 *   tools: [...],
 *   parent: querySpine,
 *   orchestrate: chain(steps, (step, i) => ({
 *     task: { content: step.description, systemPrompt: renderWorker({ taskIndex: i }) },
 *     userContent: `Task: ${step.description}`,
 *   })),
 * });
 * ```
 *
 * @category Agents
 */
export const chain = <T>(
  items: T[],
  toStep: (item: T, index: number) => ChainStep,
): Orchestrator =>
  function* (ctx) {
    for (const [i, item] of items.entries()) {
      const step = toStep(item, i);
      if (step.beforeSpawn) yield* step.beforeSpawn();
      // A step the pool refuses contributes nothing to the spine; the chain goes on.
      let requested: Agent | null = null;
      try {
        requested = yield* ctx.spawn({ ...step.task, parent: step.task.parent ?? ctx.spine });
      } catch (e) {
        if (!(e instanceof SpawnRefused)) throw e;
      }
      const agent = requested ? yield* ctx.waitFor(requested) : null;
      const delta = agent?.result && step.userContent
        ? yield* ctx.extendSpine(step.userContent, agent.result)
        : 0;
      if (step.afterExtend) yield* step.afterExtend(delta, ctx.spine.position);
    }
  };

/**
 * Fanout orchestrator — landscape task first (optionally extending the spine),
 * then N independent domain tasks in parallel. Domain tasks fork from the
 * post-landscape root and do NOT see each other's findings.
 *
 * The canonical shape for multi-domain queries: one landscape survey that
 * loads vocabulary into the spine, then one task per independent domain.
 *
 * @example
 * ```ts
 * yield* agentPool({
 *   orchestrate: fanout(
 *     { task: { content: landscapeQuery, systemPrompt: WORKER }, userContent: 'Landscape survey' },
 *     domainQueries.map(q => ({ content: q, systemPrompt: WORKER })),
 *   ),
 * });
 * ```
 *
 * @category Agents
 */
export const fanout = (landscape: ChainStep, domains: SpawnSpec[]): Orchestrator =>
  function* (ctx) {
    // A refused landscape extends nothing; the domains fork from the spine as it is.
    let l: Agent | null = null;
    try {
      l = yield* ctx.waitFor(yield* ctx.spawn({ ...landscape.task, parent: landscape.task.parent ?? ctx.spine }));
    } catch (e) {
      if (!(e instanceof SpawnRefused)) throw e;
    }
    if (l?.result && landscape.userContent) {
      yield* ctx.extendSpine(landscape.userContent, l.result);
    }
    yield* parallel(domains)(ctx);
  };

/**
 * A node in a {@link dag} orchestrator. Dependencies are referenced by id.
 *
 * @category Agents
 */
export interface DAGNode {
  id: string;
  task: SpawnSpec;
  /** Ids of nodes that must complete before this node spawns. */
  dependsOn?: string[];
  /** User content for spine extension when this node reports. Omit to skip extension. */
  userContent?: string;
}

/**
 * DAG orchestrator — lazy spawn on dependency resolution. Independent nodes
 * run in parallel; dependent nodes wait until their dependencies complete
 * (and their findings extend the spine) before forking.
 *
 * Subsumes the design in `docs/dag-pool.md` — DAG is an orchestration
 * pattern expressed on top of the general primitive, not a pool internals
 * change.
 *
 * @category Agents
 */
export const dag = (nodes: DAGNode[]): Orchestrator => {
  validateDAG(nodes);
  return function* (ctx) {
    // Each node runs as a child Task. Dependencies are expressed by
    // awaiting the dep's Task (`yield* depTask`) — Task<T> extends
    // Future<T> extends Operation<T>, so this is the canonical Effection
    // cross-task rendezvous (see frontside.com/effection/api/v4/Task).
    //
    // Why this beats the older recursive-spawnNode-with-Sets approach:
    //   - No mutable bookkeeping. The "node N is done" signal IS the
    //     Task itself; the runtime tracks lifetimes for free.
    //   - No race window for double-spawn. Each node spawns exactly
    //     once, by definition (one entry per `tasks.set`).
    //   - Failure propagates through the dependency edges automatically:
    //     if node A throws, every task awaiting A's Task receives the
    //     same error, and structured concurrency halts the rest.
    const tasks = new Map<string, Task<void>>();
    // Node id → spawned agent id, filled as each node forks. A dependent's
    // deps have all completed (and therefore registered) before it spawns,
    // so the lookup below never races.
    const agentIds = new Map<string, number>();

    function* runNode(n: DAGNode): Operation<void> {
      // Gate: wait for every declared dep's task to complete. The map is
      // fully populated before any node body runs (spawned tasks don't
      // execute until the parent yields, and the spawn loop below is
      // synchronous between iterations).
      for (const depId of n.dependsOn ?? []) {
        yield* tasks.get(depId)!;
      }
      const after = (n.dependsOn ?? [])
        .map((d) => agentIds.get(d))
        .filter((x): x is number => typeof x === 'number');
      const spawned = yield* ctx.spawn({
        ...n.task,
        parent: n.task.parent ?? ctx.spine,
        ...(after.length > 0 ? { after } : {}),
      });
      agentIds.set(n.id, spawned.id);
      const agent = yield* ctx.waitFor(spawned);
      if (agent.result && n.userContent) {
        yield* ctx.extendSpine(n.userContent, agent.result);
      }
    }

    for (const n of nodes) {
      tasks.set(n.id, yield* spawn(() => runNode(n)));
    }
    // Await every task. Roots run first (no deps to await); descendants
    // unblock as their deps complete. Any throw inside a node propagates
    // here and halts the rest via structured concurrency.
    for (const t of tasks.values()) yield* t;
  };
};

function validateDAG(nodes: DAGNode[]): void {
  const ids = new Set(nodes.map(n => n.id));
  const duplicates = nodes.filter((n, i) => nodes.findIndex(m => m.id === n.id) !== i);
  if (duplicates.length > 0) {
    throw new Error(`dag: duplicate node ids: ${duplicates.map(n => n.id).join(', ')}`);
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`dag: node '${n.id}' depends on unknown node '${dep}'`);
    }
  }
  // Cycle detection via DFS
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map(n => [n.id, n]));
  function visit(id: string, path: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`dag: cycle detected: ${[...path, id].join(' -> ')}`);
    visiting.add(id);
    const node = byId.get(id);
    for (const dep of node?.dependsOn ?? []) visit(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const n of nodes) visit(n.id, []);
}
