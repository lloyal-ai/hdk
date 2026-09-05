import { resource, ensure, createSignal, createChannel, spawn, each, sleep, action, race } from 'effection';
import type { Operation, Subscription, Task, Signal } from 'effection';
import type { SessionContext, BranchStore } from '@lloyal-labs/sdk';
import { buildTurnDelta } from '@lloyal-labs/sdk';
import { Ctx, Store, Trace, TraceParent, GrantStoreCtx, WindDown, CancelAgent, Pause, Attachments, Ingress } from './context';
import { useTraceScope } from './trace-scope';
import type { Agent } from './Agent';
import { DefaultAgentPolicy } from './AgentPolicy';
import type { PolicyConfig } from './AgentPolicy';
import { ContextPressure } from './pressure';
import { Emitter } from './emit';
import { DefaultScheduler } from './scheduler';
import { Applier } from './apply';
import { Executor, setupAgent, makePermits, pruneAll, DEFAULT_MAX_CONCURRENT_TOOLS } from './execute';
import { prepareReplay } from './replay';
import type { Tool } from './Tool';
import {
  type Pending, type TickState, type ToolCompletion, type Ladder, type SpawnRequest, type Lineage, emptyPending,
} from './state';
import type { PoolContext } from './orchestrators';
import type { AgentTaskSpec, AgentPoolOptions, AgentPoolResult, AgentEvent, PressureThresholds } from './types';

export { ContextPressure } from './pressure';

/** The grammar that forces a recovery output to be a valid call to the pool's
 *  TERMINAL tool. `toolChoice: 'auto'` — the root rule is the bare call;
 *  `'required'` would re-emit the generation prompt the recovery turn already
 *  prefilled. `null` when the pool has no terminal tool. */
function buildTerminalGrammar(ctx: SessionContext, terminalTool: Tool): string {
  return ctx.formatChatSync(
    JSON.stringify([{ role: 'system', content: '' }, { role: 'user', content: '' }]),
    { tools: JSON.stringify([terminalTool.schema]), toolChoice: 'auto', enableThinking: false },
  ).grammar;
}

/**
 * Concurrent agent generation loop as an Effection resource.
 *
 * The pool is a scheduler over one shared KV cache. Each tick: the loop
 * OBSERVES (reclaims pruned branches, holds while paused, drains fan-out
 * completions, samples pressure once), the {@link DefaultScheduler} decides
 * what runs from that one value, the {@link Applier} enacts the decisions,
 * the {@link Executor} runs them against the store in a fixed order —
 * admitted prefills, tool dispatch, spawns, sampling, ONE batched commit —
 * and the applier interprets what came back. Every trace record and channel
 * event is a projection of one of those steps ({@link Emitter}).
 *
 * **Dispatch is per-agent serial, inter-agent concurrent.** Each agent has at
 * most one tool in flight — it parks `awaiting_tool` until the result is
 * admitted (the barrier that yields the decision boundary). Inline tools run
 * on this fiber; a `Tool.fanout` tool runs on a child, and its result is
 * tokenized and admitted here, so the store is only ever touched from this
 * fiber.
 *
 * **Resource semantics:** `provide()` suspends after all agents complete,
 * keeping branches alive so the caller can fork from them. Branches are
 * pruned when the scope exits.
 *
 * @category Agents
 */
export function useAgentPool(opts: AgentPoolOptions): Operation<Subscription<AgentEvent, AgentPoolResult>> {
  return resource(function*(provide) {
    const ctx: SessionContext = yield* Ctx.expect();
    const store: BranchStore = yield* Store.expect();
    const poolChannel = createChannel<AgentEvent, AgentPoolResult>();

    // Bridge for onProgress callbacks — an external, non-Effection callback.
    const progress = createSignal<AgentEvent, void>();
    yield* spawn(function*() {
      for (const ev of yield* each(progress)) {
        yield* poolChannel.send(ev);
        yield* each.next();
      }
    });
    const tw = yield* Trace.expect();
    const attachments = yield* Attachments.expect();
    const ingress = yield* Ingress.expect();
    const { spine, orchestrate, toolsJson, tools, maxTurns = 100, terminalToolName, trace = false, pruneOnReturn = false, enableThinking = true, eagerGrammar } = opts;

    const toolIndexMap = new Map([...tools.keys()].map((name, i) => [name, i]));
    const poolT0 = performance.now();
    let poolParentTraceId: number | null = null;
    try { const p = yield* TraceParent.get(); if (p != null) poolParentTraceId = p; } catch { /* top level */ }
    // The three consumer signals are optional capabilities: absent ⇒ no
    // wind-down / cancel / pause.
    let windDownSignal: Signal<void, void> | null = null;
    try { windDownSignal = (yield* WindDown.get()) ?? null; } catch { /* none */ }
    let cancelSignal: Signal<{ agentId: number }, void> | null = null;
    try { cancelSignal = (yield* CancelAgent.get()) ?? null; } catch { /* none */ }
    let pauseSignal: Signal<boolean, void> | null = null;
    try { pauseSignal = (yield* Pause.get()) ?? null; } catch { /* none */ }
    const poolScopeId = yield* useTraceScope(tw, poolParentTraceId, 'pool', { maxTurns, terminalToolName });
    const emit = new Emitter(tw, poolChannel, poolScopeId);

    // Whether the registry holds tools besides the terminal one: when not, an
    // agent may report as its first action (a reporter sub-agent).
    const hasNonTerminalTools = terminalToolName ? [...tools.keys()].some(k => k !== terminalToolName) : tools.size > 0;
    const terminalTool = terminalToolName ? tools.get(terminalToolName) : undefined;
    const terminalGrammar = terminalTool ? buildTerminalGrammar(ctx, terminalTool) : null;
    const policy = opts.policy ?? new DefaultAgentPolicy();

    // The run clock: wall time minus paused spans. Policy budgets and
    // `agent.startedAt` read it; trace `ts` and retry parks stay on the wall.
    let paused = false;
    let pausedTotal = 0;
    const runNow = (): number => performance.now() - pausedTotal;
    policy.bindClock?.(runNow);
    const pressureOpts: PressureThresholds = policy.pressureThresholds
      ?? { softLimit: ContextPressure.DEFAULT_SOFT_LIMIT, hardLimit: ContextPressure.DEFAULT_HARD_LIMIT };

    // Invariant: hardLimit ≥ nBatch, else recovery's next batch allocation OOMs.
    const nBatch = ContextPressure.ASSUMED_N_BATCH;
    const hardLimitVal = pressureOpts.hardLimit ?? ContextPressure.DEFAULT_HARD_LIMIT;
    if (hardLimitVal < nBatch) {
      throw new Error(
        `useAgentPool: Invariant Violation — hardLimit (${hardLimitVal}) must be >= nBatch (${nBatch}). ` +
        `Recovery reserves hardLimit cells for its own decode; if smaller than nBatch, the next batch ` +
        `allocation will OOM. Increase policy.budget.context.hardLimit to at least ${nBatch}.`,
      );
    }

    // authGuard inputs, resolved once: protected names and the session's grants.
    const protectedTools = new Set([...tools].filter(([, t]) => t.protected).map(([name]) => name));
    let grants: ReadonlySet<string> = new Set();
    if (protectedTools.size > 0) {
      try {
        const grantStore = yield* GrantStoreCtx.expect();
        grants = new Set(yield* grantStore.granted());
      } catch { /* no grant store — fail-closed */ }
    }
    // Public numbers read raw would fail quietly later: a non-positive recovery
    // budget cuts every report at its first token; a non-positive permit count
    // hangs the first fan-out call forever. Refused here, with the value named.
    const requirePositiveInteger = (name: string, value: number | undefined): void => {
      if (value === undefined) return;
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`useAgentPool: ${name} must be a positive integer, got ${value}`);
      }
    };
    requirePositiveInteger('policy.recoveryBudget', policy.recoveryBudget);
    requirePositiveInteger('maxConcurrentTools', opts.maxConcurrentTools);

    const config: PolicyConfig = { maxTurns, terminalToolName, hasNonTerminalTools, protectedTools, grants };

    // ── The pool's state ─────────────────────────────────────────
    const agents: Agent[] = [];
    const pending: Pending = emptyPending();
    const ladder: Ladder = { consecutiveFatalRc: 0, backendSuspect: false };
    const counters = { warmPrefillCalls: 0, warmPrefillBranches: 0 };
    const totals = { toolCalls: 0, steps: 0 };
    const inflight = new Map<number, Task<void>>();
    const completed: ToolCompletion[] = [];
    const pendingCancels: number[] = [];
    /** One wake for everything that can make a waiting tick runnable. */
    const wake = createSignal<void, void>();
    let windingDown = false;
    let orchestratorDone = false;
    let orchestratorError: unknown = null;

    // Teardown frees every leaf branch, children first.
    yield* ensure(() => { pruneAll(agents, emit); });

    emit.trace({ kind: 'opened', pressure: new ContextPressure(ctx, pressureOpts) });

    // Recovery shape and report budget are cohort decisions: read once off the
    // policy (where callers configure them) and handed to the scheduler.
    const scheduler = new DefaultScheduler({
      recovery: policy.recoveryShape === 'parallel' ? 'cohort' : 'serial',
      recoveryBudget: policy.recoveryBudget,
      terminalToolName, config,
    }, ctx, tools);
    /**
     * The one way a spawn request is made: fork, format the suffix, and — for
     * a heal — build and price the lineage the replacement will replay, so
     * admission sees everything the request will prefill. A replacement forks
     * the spine, as the original's replay carries what came after the fork.
     */
    function* forge(task: AgentTaskSpec, lineage?: Lineage): Operation<Omit<SpawnRequest, 'resolve' | 'reject' | 'discarded'>> {
      const parent = lineage ? spine : (task.parent ?? spine);
      const { agent, suffixTokens, formattedPrompt } = yield* setupAgent(parent, task, ctx, enableThinking, runNow);
      if (!lineage) return { agent, suffixTokens, formattedPrompt, task };
      const { steps, cells } = yield* prepareReplay(lineage.records, { enableThinking: agent.fmt.enableThinking });
      return { agent, suffixTokens, formattedPrompt, task, replay: { steps, cells, of: lineage.of, rc: lineage.rc, attempt: lineage.attempt } };
    }

    const applier = new Applier({
      ctx, policy, config, tools, emit, pending, ladder,
      recovery: policy.recoveryShape === 'parallel' ? 'cohort' : 'serial',
      recoveryBudget: policy.recoveryBudget, terminalToolName, pruneOnReturn, pressureOpts, totals,
      forge,
    });
    const executor = new Executor({
      ctx, store, tools, emit, tw, pending, agents, inflight,
      permits: makePermits(opts.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS),
      completed, wake, progress, scorer: opts.scorer, toolIndexMap, toolkitSize: tools.size,
      terminalGrammar, eagerGrammar, enableThinking, spine, runNow, counters, totals, policy,
      pressureOpts, ingress, attachments, ladder, trace,
    });

    // ── PoolContext — the orchestrator's API ─────────────────────
    const poolContext: PoolContext = {
      spine,

      *spawn(spec) {
        const parent = spec.parent ?? spine;
        const task: AgentTaskSpec = {
          systemPrompt: spec.systemPrompt, content: spec.content, tools: toolsJson, seed: spec.seed,
          ...(spec.after && spec.after.length > 0 ? { after: spec.after } : {}),
          parent, assignedAbility: spec.assignedAbility,
        };
        // Fork now (metadata only); the suffix prefill and the activation are
        // the scheduler's. Suspend until admitted — or rejected for pressure.
        const forged = yield* forge(task);
        const admitted = yield* action<Agent>((resolve, reject) => {
          const req: SpawnRequest = { ...forged, resolve, reject, discarded: false };
          pending.spawns.push(req);
          wake.send();
          return () => { req.discarded = true; };
        });
        return admitted;
      },

      *waitFor(agent) {
        // `spawn` resolves only once the agent is active, so `idle` here is
        // terminal, never the pre-activation default. Check BEFORE subscribing:
        // `each` blocks until the next emission, and a transition that already
        // fired is not replayed.
        if (agent.status === 'idle' || agent.status === 'disposed') return agent;
        for (const s of yield* each(agent.statusSignal)) {
          if (s === 'idle' || s === 'disposed') return agent;
          yield* each.next();
        }
        return agent;
      },

      *extendSpine(userContent, assistantContent) {
        if (!assistantContent) return 0;
        const tokens = buildTurnDelta(ctx, userContent, assistantContent);
        return yield* action<number>((resolve, reject) => {
          const req = { tokens, userContent, assistantContent, resolve, reject, discarded: false };
          pending.extends.push(req);
          wake.send();
          return () => { req.discarded = true; };
        });
      },

      canFit(estimatedSuffixTokens) {
        return new ContextPressure(ctx, pressureOpts).canFit(estimatedSuffixTokens);
      },
    };

    // Subscribe before anything can emit.
    const subscription = yield* poolChannel;

    const orchestratorTask = yield* spawn(function*() {
      try {
        yield* orchestrate(poolContext);
      } catch (e) {
        orchestratorError = e;
      } finally {
        orchestratorDone = true;
        wake.send();
      }
    });

    // ── Signals ──────────────────────────────────────────────────
    if (windDownSignal) {
      const wd = windDownSignal;
      yield* spawn(function*() {
        const sub = yield* wd;
        yield* sub.next();
        // Halt the orchestrator BEFORE flipping: a reap's idle transition would
        // otherwise resume its waitFor and let it spawn against a draining pool.
        yield* orchestratorTask.halt();
        windingDown = true;
        wake.send();
        yield* emit.emit({ kind: 'windingDown' });
      });
    }
    if (cancelSignal) {
      const cs = cancelSignal;
      yield* spawn(function*() {
        const sub = yield* cs;
        for (;;) {
          const next = yield* sub.next();
          if (next.done) break;
          pendingCancels.push(next.value.agentId);
          wake.send();
        }
      });
    }
    if (pauseSignal) {
      const ps = pauseSignal;
      yield* spawn(function*() {
        const sub = yield* ps;
        for (;;) {
          const next = yield* sub.next();
          if (next.done) break;
          paused = next.value;
          wake.send();
        }
      });
    }

    // ── The tick loop ────────────────────────────────────────────
    yield* spawn(function*() {
      try {
        const wakeSub = yield* wake;
        let tick = 0;
        let wasPaused = false;
        let heldAt = 0;
        let idleTicks = 0;

        for (;;) {
          // OBSERVE — reclaim, hold, drain, sample.
          if (executor.prunePass() > 0) {
            yield* emit.emit({ kind: 'kvTick', pressure: new ContextPressure(ctx, pressureOpts) });
          }
          if (paused && !wasPaused) {
            heldAt = performance.now();
            yield* emit.emit({ kind: 'paused', ts: heldAt });
            wasPaused = true;
          }
          if (paused && pendingCancels.length === 0) {
            // Hold: nothing decodes until play. A cancel arriving mid-hold runs
            // as a hold tick (reclamation needs no decode).
            yield* wakeSub.next();
            continue;
          }
          if (!paused && wasPaused) {
            const pausedMs = performance.now() - heldAt;
            pausedTotal += pausedMs;
            yield* emit.emit({ kind: 'resumed', pausedMs });
            wasPaused = false;
          }
          for (const c of completed.splice(0)) yield* executor.intake(c);
          if (idleTicks > 0 && !paused && pendingCancels.length === 0) {
            // Nothing ran last tick: wait for a wake or the next parked retry.
            const nextDue = pending.retries.length > 0
              ? Math.min(...pending.retries.map(r => r.notBefore)) - performance.now()
              : 50;
            yield* race([sleep(Math.max(1, Math.min(50, nextDue))), wakeSub.next()]);
            for (const c of completed.splice(0)) yield* executor.intake(c);
          }
          const state: TickState = {
            tick: tick++,
            now: runNow(),
            wall: performance.now(),
            pressure: new ContextPressure(ctx, pressureOpts),
            agents,
            pending,
            signals: { paused, windDown: windingDown, cancelled: pendingCancels.splice(0), orchestratorDone },
            inflight: new Set(inflight.keys()),
          };

          // SCHEDULE — one pure decision over one value.
          const S = scheduler.schedule(state, policy);
          Object.assign(pending, S.remaining);
          yield* applier.applySchedule(S);
          if (S.close) {
            if (orchestratorError) throw orchestratorError;
            break;
          }
          // EXECUTE, then APPLY what came back.
          const out = yield* executor.run(S);
          yield* applier.applyOutputs(out, S);

          // Quiet = nothing ran and nothing admissible waits: only parked
          // retries, in-flight tools, or an orchestrator that may still spawn.
          const ran = S.prefills.length + S.spawns.length + S.extends.length
            + S.dispatch.length + S.decode.length + S.drops.length + S.finishes.length
            + S.halts.length + S.stall.length + (S.sweep ? 1 : 0) + S.abandoned.length;
          const waiting = pending.items.length + pending.dispatches.length + pending.spawns.length
            + pending.extends.length;
          idleTicks = ran === 0 && waiting === 0 ? idleTicks + 1 : 0;
        }

        emit.trace({ kind: 'closed', agents, steps: totals.steps, durationMs: performance.now() - poolT0 });
        yield* poolChannel.close(result());
      } catch {
        // A decode failed beyond the ladder, or the orchestrator threw: close
        // with what exists. No `pool:close` — its absence is the signal.
        yield* poolChannel.close(result());
      }
    });

    /** The per-agent results — the same record on the normal and partial paths. */
    function result(): AgentPoolResult {
      return {
        agents: agents.map(a => ({
          agentId: a.id,
          parentAgentId: a.parentId,
          branch: a.branch,
          agent: a,
          result: a.result,
          exitReason: a.exitReason,
          toolCallCount: a.toolCallCount,
          tokenCount: a.tokenCount,
          ppl: a.branch.disposed ? (a.finalPpl ?? 0) : a.branch.perplexity,
          samplingPpl: a.branch.disposed ? (a.finalSamplingPpl ?? 0) : a.branch.samplingPerplexity,
          trace: trace ? a.traceBuffer : undefined,
          nestedResults: [...a.nestedResults],
        })),
        totalTokens: agents.reduce((s, a) => s + a.tokenCount, 0),
        totalToolCalls: totals.toolCalls,
        steps: totals.steps,
        counters,
      };
    }

    yield* provide(subscription);
  });
}
