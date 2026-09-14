import { resource, ensure, createSignal, createChannel, createQueue, spawn, each, sleep, action, race } from 'effection';
import type { Operation, Subscription, Task, Signal } from 'effection';
import type { SessionContext, BranchStore } from '@lloyal-labs/sdk';
import type { Attachment } from '@lloyal-labs/media';
import { buildTurnDelta } from '@lloyal-labs/sdk';
import { Ctx, Store, Trace, TraceParent, CallingAgent, GrantStoreCtx, WindDown, CancelAgent, Pause, Attachments, Ingress, PoolDefaults } from './context';
import { useTraceScope } from './trace-scope';
import type { Agent } from './Agent';
import { policyFromBudget } from './AgentPolicy';
import type { PolicyConfig } from './AgentPolicy';
import { ContextPressure } from './pressure';
import { Emitter } from './emit';
import { DefaultScheduler } from './scheduler';
import { Applier } from './apply';
import { Executor, priceSpawn, makePermits, pruneAll, DEFAULT_MAX_CONCURRENT_TOOLS } from './execute';
import type { PricedSpawn } from './execute';
import { SpawnLedger } from './spawns';
import type { SpawnEntry } from './spawns';
import { makeFrame } from './hooks';
import { prepareReplay } from './replay';
import type { Tool } from './Tool';
import {
  type Pending, type TickState, type ToolCompletion, type Ladder, type SpawnReplay, type Lineage, emptyPending,
} from './state';
import type { PoolContext } from './orchestrators';
import type { AgentTaskSpec, AgentPoolOptions, AgentPoolResult, AgentEvent, PressureThresholds } from './types';

export { ContextPressure } from './pressure';
export { SpawnRefused } from './spawns';

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
 * **Admission.** A spawn is a priced request — its suffix tokenized, its
 * format fixed, no branch — until the scheduler seats it: the KV fits, a
 * sequence is vacant, the pool is under `capacity`. The executor forks it then.
 * What cannot be seated waits in request order while a sibling can still free
 * room, and is refused with a named reason when none can, so every topology
 * runs in waves and no fork is ever made on faith. Each spawn keeps one entry
 * in the pool's ledger across heals: `waitFor` resolves to the lineage's final
 * agent, and `AgentPoolResult.outcomes` carries one final outcome per spawn, in
 * spawn order, read back by `key`.
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
    // Assets available to the run: staged by the host now, grown by every
    // tool result that admits a root. One list, owned here — it outlives any
    // agent, so a root agent A admitted stays available after A is pruned.
    const available: Attachment[] = [...(opts.attachments ?? [])];
    const { spine, orchestrate, toolsJson, tools, terminalToolName, eagerGrammar } = opts;
    // The knobs a harness fixes once come from the context; the call's own option wins.
    const defaults = yield* PoolDefaults.expect();
    const maxTurns = opts.maxTurns ?? opts.budget?.maxTurns ?? 100;
    const trace = opts.trace ?? defaults.trace ?? false;
    const pruneOnReturn = opts.pruneOnReturn ?? defaults.pruneOnReturn ?? false;
    const enableThinking = opts.enableThinking ?? defaults.enableThinking ?? true;

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

    const terminalTool = terminalToolName ? tools.get(terminalToolName) : undefined;
    const terminalGrammar = terminalTool ? buildTerminalGrammar(ctx, terminalTool) : null;
    // One policy per pool: the caller's own, or the one its budget row derives —
    // with this pool's terminal and the harness's guard overrides on it.
    if (opts.policy && (opts.budget || opts.guards || opts.hooks || opts.acceptFreeText !== undefined)) {
      throw new Error('useAgentPool: pass `budget`, `guards`, `hooks` and `acceptFreeText`, or a `policy` — not both: a policy carries its own');
    }
    const policy = opts.policy ?? policyFromBudget(opts.budget ?? {}, { terminalToolName, guardOverrides: opts.guards, hooks: opts.hooks, acceptFreeText: opts.acceptFreeText });
    // The terminal's identity, decided once, here.
    policy.bindTerminal?.(terminalToolName);

    // The run clock: wall time minus paused spans. Policy budgets and
    // `agent.startedAt` read it; trace `ts` and retry parks stay on the wall.
    let paused = false;
    let pausedTotal = 0;
    const runNow = (): number => performance.now() - pausedTotal;
    policy.bindClock?.(runNow);
    // Public numbers read raw would fail quietly later: a non-positive recovery
    // budget cuts every report at its first token; a non-positive permit count
    // hangs the first fan-out call forever; a NaN hard limit disables
    // `critical`, an infinite one makes every reading critical; a negative or
    // NaN soft limit widens or poisons `headroom`. Refused here, with the value
    // named. Cells are integers, so every one of them is an integer.
    const requireInteger = (name: string, value: number, min: number, why = ''): number => {
      if (!Number.isInteger(value) || value < min) {
        throw new Error(`useAgentPool: ${name} must be an integer >= ${min}${why}, got ${value}`);
      }
      return value;
    };
    const pressureOpts: PressureThresholds = {
      softLimit: requireInteger('softLimit', policy.pressureThresholds?.softLimit ?? ContextPressure.DEFAULT_SOFT_LIMIT, 0),
      hardLimit: requireInteger('hardLimit', policy.pressureThresholds?.hardLimit ?? ContextPressure.DEFAULT_HARD_LIMIT,
        ContextPressure.ASSUMED_N_BATCH, ' (nBatch: recovery reserves hardLimit cells for its own decode, and a smaller reserve OOMs the next batch)'),
    };

    // The authorization gate's inputs, resolved once: protected names and the session's grants.
    const protectedTools = new Set([...tools].filter(([, t]) => t.protected).map(([name]) => name));
    let grants: ReadonlySet<string> = new Set();
    if (protectedTools.size > 0) {
      try {
        const grantStore = yield* GrantStoreCtx.expect();
        grants = new Set(yield* grantStore.granted());
      } catch { /* no grant store — fail-closed */ }
    }
    // The framework's contributor to every call's lifecycle: the auth gate
    // first, the defaults last. One value per pool.
    const frame = makeFrame({ protectedTools, grants });
    if (policy.recoveryBudget !== undefined) requireInteger('policy.recoveryBudget', policy.recoveryBudget, 1);
    if (opts.maxConcurrentTools !== undefined) requireInteger('maxConcurrentTools', opts.maxConcurrentTools, 1);
    if (opts.capacity !== undefined) requireInteger('capacity', opts.capacity, 1);

    // ── The pool's state ─────────────────────────────────────────
    const agents: Agent[] = [];
    /** The ledger of spawns: one entry per request, carried across heals. */
    const spawns = new SpawnLedger();
    /** Forks made at admission and not yet in the roster. A fork is the pool's
     *  from the fork until it enters the roster (the executor removes it there)
     *  or is given back (`discardFork`); whatever is left is released at every
     *  close and at teardown — the one owner between fork and roster. */
    const forged = new Set<Agent>();
    const config: PolicyConfig = { maxTurns, terminalToolName };
    const pending: Pending = emptyPending();
    const ladder: Ladder = { consecutiveFatalRc: 0, backendSuspect: false };
    const counters = { warmPrefillCalls: 0, warmPrefillBranches: 0 };
    const totals = { toolCalls: 0, steps: 0 };
    const inflight = new Map<number, Task<void>>();
    const completed: ToolCompletion[] = [];
    const pendingCancels: number[] = [];
    /** One wake for everything that can make a waiting tick runnable: a queue,
     *  because it is added to from other operations (the orchestrator, fan-out
     *  children) and from plain callbacks (the signal watchers) alike, and read
     *  by one consumer, the loop. A signal is for callbacks only. */
    const wake = createQueue<void, never>();
    let windingDown = false;
    /** Set the moment the loop decides to close, on either path, before
     *  anything is released: a producer that wakes afterwards is refused at
     *  once instead of forging a branch and suspending on an admission nobody
     *  will run. */
    let closed = false;
    let orchestratorDone = false;
    let orchestratorError: unknown = null;

    /** Give back every fork that was made at admission and never entered the roster. Runs after the
     *  native work has settled (the executor's `waitUntilSettled` ensure runs as
     *  its operation unwinds), and BEFORE the roster prune: a forged fork under
     *  a roster agent would make that agent a non-leaf the leaf-only prune
     *  skips. Both calls are no-ops on a fork already given back. */
    function releaseUnadmitted(): void {
      for (const a of forged) {
        if (!a.branch.disposed) a.branch.pruneSync();
        a.dispose();
      }
      forged.clear();
    }

    // Teardown gives back the unadmitted forks, then frees every leaf branch, children first.
    yield* ensure(() => { releaseUnadmitted(); pruneAll(agents, emit); });

    emit.trace({ kind: 'opened', pressure: new ContextPressure(ctx, pressureOpts) });

    // Recovery shape and report budget are cohort decisions: read once off the
    // policy (where callers configure them) and handed to the scheduler.
    const scheduler = new DefaultScheduler({
      recovery: policy.recoveryShape === 'parallel' ? 'cohort' : 'serial',
      recoveryBudget: policy.recoveryBudget,
      terminalToolName,
      capacity: opts.capacity,
    }, ctx, tools, frame);
    /**
     * The one way a spawn request is priced: its format, its suffix and, for a
     * heal, the lineage the replacement will replay — built and priced FIRST, so
     * admission sees everything the request will prefill, and a lineage that
     * cannot be rebuilt (its content gone from the store) fails before any
     * request exists. No fork is made here: the executor forks an admitted
     * request, at admission, when a sequence is known to be vacant. A pool that
     * has closed while a spawn was being priced makes no request either.
     */
    function* price(task: AgentTaskSpec, lineage?: Lineage): Operation<PricedSpawn & { replay?: SpawnReplay }> {
      const replay = lineage ? yield* prepareReplay(lineage.records, { enableThinking }) : null;
      if (closed) throw new Error('useAgentPool: the pool has closed');
      const priced = yield* priceSpawn(task, ctx, enableThinking);
      if (!lineage || !replay) return priced;
      return { ...priced, replay: { ...replay, of: lineage.of, rc: lineage.rc, attempt: lineage.attempt, history: lineage.history, forkHead: lineage.forkHead } };
    }

    const applier = new Applier({
      ctx, policy, config, tools, frame, emit, pending, spawns, ladder,
      recoveryBudget: policy.recoveryBudget, terminalToolName, pruneOnReturn, pressureOpts, totals,
    });
    const executor = new Executor({
      ctx, store, tools, emit, tw, pending, agents, forged, spawns, inflight,
      permits: makePermits(opts.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS),
      completed, wake, progress, scorer: opts.scorer, toolIndexMap, toolkitSize: tools.size,
      terminalGrammar, eagerGrammar, enableThinking, spine, runNow, counters, totals, policy, frame,
      pressureOpts, ingress, attachments, available, ladder, trace,
    });

    // ── PoolContext — the orchestrator's API ─────────────────────
    const poolContext: PoolContext = {
      spine,

      *spawn(spec) {
        if (closed) throw new Error('useAgentPool: the pool has closed');
        const parent = spec.parent ?? spine;
        const task: AgentTaskSpec = {
          systemPrompt: spec.systemPrompt, content: spec.content, tools: toolsJson, seed: spec.seed,
          ...(spec.after && spec.after.length > 0 ? { after: spec.after } : {}),
          parent, assignedAbility: spec.assignedAbility, ...(spec.key !== undefined ? { key: spec.key } : {}),
        };
        // The entry first: a repeated key is refused before anything is priced.
        const entry = spawns.open(spec.key);
        // Who is calling — a delegate's spawn runs inside its tool call — is read
        // here, where it is known; the fork happens later, on the loop.
        const caller = (yield* CallingAgent.get()) ?? null;
        const priced = yield* price(task);
        // Post the priced request and suspend until it is admitted and forked, or
        // refused (`SpawnRefused`, with the outcome the ledger recorded).
        return yield* action<Agent>((resolve, reject) => {
          const req = { index: entry.index, key: spec.key, task, ...priced, parent, caller, resolve, reject, discarded: false };
          pending.spawns.push(req);
          wake.add();
          return () => { req.discarded = true; };
        });
      },

      *waitFor(agent) {
        // The spawn's entry, not the agent: a heal moves the entry to its
        // replacement, and the waiter resumes against the lineage's final agent.
        const entry = spawns.of(agent);
        if (!entry) { yield* agent.final; return agent; }
        yield* spawns.settled(entry);
        return entry.agent ?? agent;
      },

      *extendSpine(userContent, assistantContent) {
        if (closed) throw new Error('useAgentPool: the pool has closed');
        if (!assistantContent) return 0;
        const tokens = buildTurnDelta(ctx, userContent, assistantContent);
        return yield* action<number>((resolve, reject) => {
          const req = { tokens, userContent, assistantContent, resolve, reject, discarded: false };
          pending.extends.push(req);
          wake.add();
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
        wake.add();
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
        wake.add();
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
          wake.add();
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
          wake.add();
        }
      });
    }

    // ── The tick loop ────────────────────────────────────────────
    yield* spawn(function*() {
      try {
        let tick = 0;
        let wasPaused = false;
        let heldAt = 0;
        let idleTicks = 0;

        for (;;) {
          // OBSERVE — reclaim, hold, drain, sample.
          if (executor.prunePass() > 0) {
            yield* emit.emit({ kind: 'kvTick', pressure: new ContextPressure(ctx, pressureOpts) });
          }
          // Heals the ladder decided are priced and queued here, after the prune
          // pass has reclaimed what it could: a replacement forks the original's
          // parent and needs a sequence, and the poisoned branch is the one that
          // just gave one back. An original with live children is not reclaimed
          // yet; its heal is queued all the same — once, now — and admitted or
          // refused like any spawn, never held for a reclamation that may not
          // come. A pricing that throws (lineage content gone) stands down, as
          // does a fork whose parent is gone or has moved since: the original's
          // failure already stands, and nothing else goes with it.
          for (const a of agents) {
            const lineage = a.heal;
            if (!lineage) continue;
            a.heal = null;
            const entry = spawns.of(a);
            if (windingDown || !a.spec || !entry) continue;
            try {
              const priced = yield* price(a.spec, lineage);
              spawns.healing(entry);
              pending.spawns.push({
                index: entry.index, key: entry.key, task: a.spec, ...priced,
                // The replacement inherits the original's caller, not nothing: the branch parent
                // carries the attention, and this carries the RECEIPTS — `Agent.attendedResults`
                // walks this chain, so a heal that dropped it would re-attend evidence the lineage
                // had already seen, and a receipt-keyed guard would read it as unseen.
                parent: a.spec.parent ?? spine, caller: a.parent,
                resolve: () => {}, reject: () => {}, discarded: false,
              });
            } catch { /* the heal stands down; the entry settles on the original */ }
          }
          if (paused && !wasPaused) {
            heldAt = performance.now();
            yield* emit.emit({ kind: 'paused', ts: heldAt });
            wasPaused = true;
          }
          if (paused && pendingCancels.length === 0) {
            // Hold: nothing decodes until play. A cancel arriving mid-hold runs
            // as a hold tick (reclamation needs no decode).
            yield* wake.next();
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
            yield* race([sleep(Math.max(1, Math.min(50, nextDue))), wake.next()]);
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
            sequences: store.available,
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
          // Entries whose agent is final with no heal decided or pending settle now.
          spawns.settlePass();

          // Quiet = nothing ran. Whatever is still pending is either carried
          // (deferred for capacity, waiting on a sibling's progress) or arrived
          // with a wake the next wait will see: every push into the pending
          // record happens inside a tick that ran something, or comes with
          // `wake.add()`. Counting pending work here made a carried item spin
          // the loop at full speed for as long as a sibling's tool was in flight.
          const ran = S.prefills.length + S.spawns.length + S.extends.length
            + S.dispatch.length + S.decode.length + S.drops.length + S.finishes.length
            + S.halts.length + S.stall.length + S.abandoned.length;
          idleTicks = ran === 0 ? idleTicks + 1 : 0;
        }

        closed = true;
        releaseUnadmitted();
        emit.trace({ kind: 'closed', agents, steps: totals.steps, durationMs: performance.now() - poolT0 });
        yield* poolChannel.close(result(null));
      } catch (err) {
        // A decode failed beyond the ladder, or the orchestrator threw: close
        // with what exists, and say what ended it. Closing is terminal for new
        // work FIRST, then the producer is stopped, then the unadmitted forks
        // are given back — now, not at scope exit. No `pool:close` is recorded;
        // the result carries the failure.
        closed = true;
        yield* orchestratorTask.halt();
        releaseUnadmitted();
        yield* poolChannel.close(result(err instanceof Error ? err : new Error(String(err))));
      }
    });

    /** The per-agent results — the same record on the normal and partial paths, the partial one naming what ended it. */
    function result(failure: Error | null): AgentPoolResult {
      spawns.settlePass();
      return {
        failure,
        outcomes: spawns.outcomes(),
        byKey: (key: string) => spawns.byKey(key),
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
