import { createContext } from 'effection';
import type { SessionContext } from '@lloyal-labs/sdk';
import type { BranchStore, Branch } from '@lloyal-labs/sdk';
import type { Channel, Signal } from 'effection';
import type { AgentEvent } from './types';
import type { TraceWriter } from './trace-writer';
import type { TraceId } from './trace-types';
import type { Agent, FormatConfig } from './Agent';
import type { Reranker } from './chunk';
import type { AbilityRegistry } from './ability-types';
import type { AbilityConfigStore } from './ability-config';
import type { GrantStore } from './grant-store';

/**
 * Effection context holding the active {@link SessionContext}
 *
 * Set by {@link initAgents} in the caller's scope. All agent operations
 * (`useAgent`, `agentPool`, `useAgentPool`, `withSpine`, `diverge`) read from this
 * context via `yield* Ctx.expect()`.
 *
 * @category Agents
 */
export const Ctx = createContext<SessionContext>('lloyal.ctx');

/**
 * Effection context holding the active {@link BranchStore}
 *
 * Set by {@link initAgents}. Used by {@link diverge} and {@link useAgentPool}
 * for batched commit/prefill across multiple branches.
 *
 * @category Agents
 */
export const Store = createContext<BranchStore>('lloyal.store');

/**
 * Effection context holding the agent event channel
 *
 * Set by {@link initAgents}. {@link useAgentPool} emits {@link AgentEvent}
 * values through this channel via `yield* channel.send()`.
 *
 * @category Agents
 */
export const Events = createContext<Channel<AgentEvent, void>>('lloyal.events');

/**
 * Effection context holding the trace writer
 *
 * Set by {@link initAgents}. Defaults to {@link NullTraceWriter} (zero cost).
 * All agent operations read from this context to emit structured trace events.
 *
 * @category Agents
 */
export const Trace = createContext<TraceWriter>('lloyal.trace');

/**
 * Effection context carrying the current trace scope ID
 *
 * Used to build parent-child relationships across nested agent pools.
 * Set in DISPATCH before tool execution so inner pools inherit the
 * correct parent trace ID.
 *
 * @category Agents
 */
export const TraceParent = createContext<TraceId>('lloyal.traceParent');

/**
 * Effection context holding the calling agent during DISPATCH
 *
 * Set by the pool before each tool execution in `scoped()`. Tools and
 * recursive `withSpine` calls read this to access the calling
 * agent's branch (for Continuous Context forking) and tool history
 * (for deduplication guards).
 *
 * Scope-isolated: each `scoped()` DISPATCH sees only its own agent.
 * Nested pools (web_research) shadow the parent's context correctly.
 *
 * @category Agents
 */
export const CallingAgent = createContext<Agent>('lloyal.callingAgent');

/**
 * Effection context holding the spine's pre-computed {@link FormatConfig}
 * when shared system+tools mode is active.
 *
 * Set by {@link withSpine} when its `systemPrompt` option is provided.
 * The chat-format header (system + tools) is prefilled onto the spine once at
 * setup; agents forking from the spine inherit those tokens via prefix-share
 * and need the matching parser/grammar/format/triggers to dispatch tool calls
 * correctly. Storing it here lets `setupAgent` detect shared mode and copy
 * the fmt without re-emitting tool schemas in each agent's suffix.
 *
 * Defaults to `null` so non-shared `withSpine` scopes leave it unset and
 * `setupAgent` falls back to formatting per-agent system+tools+user as today.
 *
 * @category Agents
 */
export const SpineFmt = createContext<FormatConfig | null>('lloyal.spineFmt', null);

/**
 * Effection context holding the harness-wide {@link Reranker}.
 *
 * Set by the harness once via `RerankerCtx.set(reranker)` after
 * `createReranker(...)`. Ability factories (`createWebAbility`, `createCorpusAbility`,
 * third-party abilities) read this via `yield* RerankerCtx.expect()` at
 * construction time and pass it to their `Source` / search tools.
 *
 * Replaces the per-source `source.bind({reranker})` pattern — chunks
 * tokenized by one reranker can't be re-bound to another without
 * re-tokenization, so one cross-encoder per harness
 * is the invariant.
 *
 * @category Contract
 */
export const RerankerCtx = createContext<Reranker>('lloyal.reranker');

/**
 * Effection context holding the {@link AbilityRegistry}.
 *
 * Set by `createAbilityRegistry(...)` (lives in `@lloyal-labs/rig`). The
 * scope-guard reads this at tool-dispatch time to resolve
 * the allowed-tools set for an Ability-assigned spawn — looking up
 * `registry.byName(spawn.assignedAbility)` and matching the dispatched
 * `toolName` against `manifest.protocol.tools`.
 *
 * The spine renderer also reads this to compose the catalog in
 * registration order.
 *
 * @category Contract
 */
export const AbilityRegistryCtx = createContext<AbilityRegistry>('lloyal.abilityRegistry');

/**
 * Effection context holding the harness's {@link AbilityConfigStore}.
 *
 * Set by `createAbilityRegistry({ configStore })` from its `configStore`
 * option, and seeded into each ability's detached scope so factories can
 * read it. Ability factories read their own config via
 * `(yield* AbilityConfigStoreCtx.expect()).get(manifest.name)` at
 * construction time. The framework validates the stored config against
 * `ability.manifest.configSchema` when the ability is enabled.
 *
 * Whole-replace semantics on `set`; last-write-wins on concurrent
 * writes.
 *
 * @category Contract
 */
export const AbilityConfigStoreCtx = createContext<AbilityConfigStore>('lloyal.abilityConfigStore');

/**
 * Effection context holding the session's {@link GrantStore}.
 *
 * Seeded by `createAbilityRegistry({ grantStore })` (lives in `@lloyal-labs/rig`)
 * alongside {@link AbilityConfigStoreCtx}. The authGuard
 * reads it once per pool to resolve which `protected` tools the session is
 * authorized to call — `protected` tools without a grant reject at dispatch
 * time (`tool:authReject`). The store holds the consent decision; the
 * **credential never enters the model's context**.
 *
 * Absent context = fail-closed: no grants, every protected tool denied.
 * Open (non-protected) tools never consult it.
 *
 * @category Contract
 */
export const GrantStoreCtx = createContext<GrantStore>('lloyal.grantStore');

/**
 * Effection context holding an optional wind-down {@link Signal}.
 *
 * A consumer that wants graceful "wrap up now" provides a `createSignal<void, void>()`
 * in the pool's run scope and `.send()`s it on its Stop/Wrap-up command. The pool
 * reads it at boot (`yield* WindDown.get()`); on emission it stops spawning new
 * agents, reaps active ones to recovery, and lets in-flight tool calls **drain**
 * (complete + settle) before reaping — then the termination sweep runs each
 * policy's `onRecovery`. Answer-agnostic: what recovery yields (a report, or
 * `skip`) is the policy's call. Parked tool RETRIES are the one thing not
 * drained: a rate-limit park (often 60–90s) is abandoned with an honest
 * failure result, because the drain reports with what agents have. The flip
 * is announced on the bus as `run:windingDown`.
 *
 * This is NOT abort — aborting everything (including in-flight tools) is `halt()`'s
 * job (kill the run scope). Absent context = no wind-down capability (the pool runs
 * to natural completion).
 *
 * @category Agents
 */
export const WindDown = createContext<Signal<void, void>>('lloyal.windDown');

/**
 * Effection context holding an optional per-agent cancel {@link Signal}.
 *
 * A consumer that wants to cancel a single live agent (e.g. a per-card ×) provides a
 * `createSignal<{ agentId: number }, void>()` in the pool's run scope and
 * `.send({ agentId })`s it. The pool reads it at boot (`yield* CancelAgent.get()`); on
 * emission it halts that agent's in-flight tool (aborting the fetch), emits a terminal
 * `agent:failed` (reason `user_cancel`) — NO recovery, the user killed it deliberately —
 * and prunes its branch to reclaim KV for its siblings. Cancel = **discard**, not drain.
 *
 * This is the per-agent twin of {@link WindDown} (which reaps the whole cohort to
 * recovery). Intended for flat / independent (parallel) agents — chain agents feed the
 * spine, so the consumer wires this only where an agent's branch is a reclaimable leaf.
 * Absent context = no cancel capability.
 *
 * @category Agents
 */
export const CancelAgent = createContext<Signal<{ agentId: number }, void>>('lloyal.cancelAgent');

/**
 * Effection context holding an optional pause {@link Signal}.
 *
 * A consumer that wants pause/play provides a `createSignal<boolean, void>()`
 * in the pool's run scope and `.send(true)`s / `.send(false)`s it. The pool
 * reads it at boot (`yield* Pause.get()`); while paused the tick loop HOLDS at
 * the tick boundary — no produce, no commit, no settle, no dispatch. Branches
 * stay resident (KV untouched); in-flight tools complete and their results
 * queue as data, settling on the first tick after play. Policy time budgets
 * measure RUN time (paused spans excluded); retry parks stay on the wall
 * clock — rate limits elapse in the real world.
 *
 * Pause takes effect at the next tick boundary: an in-flight recovery decode
 * (`recoverInline`, the termination sweep) completes first. Lifecycle
 * sequencing is the harness's job — the pool holds while paused regardless of
 * other signals; conflicting commands (wind-down while paused) are the
 * consumer's to refuse. Absent context = no pause capability.
 *
 * This is the whole-run sibling of {@link WindDown} (drain) and
 * {@link CancelAgent} (targeted discard); `halt()` remains the discard-now
 * control. Pause keeps everything and goes nowhere.
 *
 * @category Agents
 */
export const Pause = createContext<Signal<boolean, void>>('lloyal.pause');
