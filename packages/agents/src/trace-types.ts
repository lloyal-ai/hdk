import type { ToolHistoryEntry } from './Agent';

/**
 * Monotonically increasing trace ID
 *
 * Allocated by {@link TraceWriter.nextId}. Cheap — just an incrementing
 * counter. Used to build parent-child relationships across scopes, agent
 * pools, and tool dispatches in the trace tree.
 *
 * @category Agents
 */
export type TraceId = number;

/** Base shape for all trace events */
interface TraceEventBase {
  traceId: TraceId;
  parentTraceId: TraceId | null;
  ts: number; // performance.now()
}

/**
 * Discriminated union of all trace event types
 *
 * Every variant extends {@link TraceEventBase} with a `type` discriminant.
 * Events cover the full lifecycle of agent execution: scope open/close,
 * prompt formatting, branch creation/prefill/prune, generation start/end,
 * agent pool ticks, tool dispatch/result, diverge attempts, reranker
 * passes, and source bindings.
 *
 * Written to a {@link TraceWriter} throughout the runtime. Consumers
 * (e.g. {@link JsonlTraceWriter}) serialize events to JSONL for
 * post-hoc analysis.
 *
 * @category Agents
 */
export type TraceEvent =
  // ── Scope events ────────────────────────────
  | TraceEventBase & { type: 'scope:open'; name: string; meta?: Record<string, unknown> }
  | TraceEventBase & { type: 'scope:close'; name: string; durationMs: number }

  // ── Prompt events ───────────────────────────
  | TraceEventBase & {
      type: 'prompt:format';
      /** The spawned agent this prompt seeds (role 'agentSuffix' writes) —
       *  the tee's attribution key; absent on spine/generate writes. */
      agentId?: number;
      promptText: string;
      taskContent?: string;
      tokenCount: number;
      messages: string;
      tools?: string;
      grammar?: string;
      role: 'spine' | 'agentSuffix' | 'generate' | 'diverge' | 'toolResultDelta';
    }

  // ── Branch events ───────────────────────────
  | TraceEventBase & {
      type: 'branch:create';
      branchHandle: number;
      parentHandle: number | null;
      position: number;
      role: 'root' | 'spine' | 'agentFork' | 'divergeAttempt';
    }
  | TraceEventBase & {
      type: 'branch:prefill';
      branchHandle: number;
      tokenCount: number;
      role: 'spineHeader' | 'agentSuffix' | 'toolResult' | 'warmDelta' | 'probe' | 'recovery';
      probeText?: string;
      /** Verbatim prefilled text. Populated for `warmDelta` (session-trunk
       *  conversation turns) so the spine's accreting content is visible in
       *  the trace — parallels `generate:end.output`. Omitted for the
       *  pool-side prefills (spineHeader/toolResult/recovery), whose text is
       *  already recoverable from prompt:format / tool:result / pool:recovery*. */
      content?: string;
    }
  | TraceEventBase & { type: 'branch:prune'; branchHandle: number; position: number }

  // ── Generation events ───────────────────────
  | TraceEventBase & {
      type: 'generate:start';
      branchHandle: number;
      hasGrammar: boolean;
      hasParent: boolean;
      role: string;
    }
  | TraceEventBase & {
      type: 'generate:end';
      branchHandle: number;
      tokenCount: number;
      output: string;
      parsed?: unknown;
    }

  // ── Agent pool events ───────────────────────
  | TraceEventBase & {
      type: 'pool:open';
      agentCount: number;
      taskSuffixTokens: number[];
      /** `remaining`/`headroom` are null when the context is unlimited
       *  (`nCtx <= 0` — they'd otherwise be Infinity, which JSON can't carry). */
      pressure: { remaining: number | null; softLimit: number; headroom: number | null };
    }
  | TraceEventBase & {
      type: 'pool:close';
      agents: Array<{
        agentId: number;
        tokenCount: number;
        toolCallCount: number;
        result: string | null;
        ppl: number;
      }>;
      totalTokens: number;
      steps: number;
      /** WALL-clock duration — includes paused spans (observability keeps
       *  real time; only policy budgets exclude pauses). */
      durationMs: number;
    }
  | TraceEventBase & {
      type: 'pool:tick';
      phase: 'PRODUCE' | 'COMMIT' | 'SETTLE' | 'DISPATCH';
      activeAgents: number;
      /** `remaining`/`headroom` are null when the context is unlimited
       *  (`nCtx <= 0` — they'd otherwise be Infinity, which JSON can't carry). */
      pressure: { remaining: number | null; cellsUsed: number; nCtx: number; headroom: number | null };
    }
  // The pause hold, in the file's pool dialect (the bus twin is
  // `run:paused`/`run:resumed`). Between a pool:pause and its pool:resume
  // there are NO native store calls — invariant I32.
  | TraceEventBase & { type: 'pool:pause' }
  | TraceEventBase & { type: 'pool:resume'; pausedMs: number }
  | TraceEventBase & { type: 'pool:windDown' }
  | TraceEventBase & {
      type: 'pool:agentDrop';
      agentId: number;
      reason:
        | 'pressure_init'
        | 'pressure_critical'
        | 'pressure_softcut'
        | 'pressure_settle_reject'
        | 'settle_stall_break'
        | 'time_exceeded'
        | 'policy_exit'
        | 'maxTurns'
        | 'tool_error'
        | 'stop_token'
        | 'wind_down'
        | 'user_cancel';
    }
  | TraceEventBase & {
      type: 'pool:agentNudge';
      agentId: number;
      reason: 'pressure_softcut' | 'pressure_settle_reject' | 'settle_reject' | 'time_nudge' | 'nudge';
      message?: string;
      /** The tool call the nudge replaced (PRODUCE nudges reject a parsed
       *  call; settle_reject nudges replace an oversized result). Absent
       *  when no call was in hand. */
      tool?: string;
      args?: string;
      /** The rejecting {@link ToolGuard.name} when a guard produced this
       *  nudge (`url_dedup`, `query_dedup`, `auth_reject`, or a harness
       *  guard's own name). Absent for budget/pressure nudges. */
      guard?: string;
    }

  // ── Recovery diagnostics ────────────────────
  // Emitted by recoverInline so silent failures become visible in the
  // trace. A recovery prefill is always followed by exactly one of:
  // `pool:recoveryReturn` (parsed findings captured) or
  // `pool:recoveryFailed` (produce completed but output unparseable).
  | TraceEventBase & {
      type: 'pool:recoveryProduce';
      agentId: number;
      tokenCount: number;
      outputLength: number;
    }
  | TraceEventBase & {
      type: 'pool:recoveryReturn';
      agentId: number;
      resultLength: number;
    }
  | TraceEventBase & {
      type: 'pool:recoveryFailed';
      agentId: number;
      reason: string;
      outputExcerpt: string;
    }

  // ── Agent lifecycle span ─────────────────────
  // Trace mirrors of the bus events: `agent:spawn` opens the agent's span
  // (`parentAgentId` = the parent BRANCH handle — the spine for pool
  // spawns), `agent:done` ends it at the drop or return. Recovery events
  // (`pool:recovery*`) may follow `agent:done` for the same agent — a span
  // consumer that wants the recovery tail extends to the last such event.
  | TraceEventBase & { type: 'agent:spawn'; agentId: number; parentAgentId: number }
  | TraceEventBase & { type: 'agent:done'; agentId: number }

  // ── Agent per-turn output ────────────────────
  | TraceEventBase & {
      type: 'agent:turn';
      agentId: number;
      turn: number;
      rawOutput: string;
      parsedContent: string | null;
      parsedToolCalls: Array<{ name: string; arguments: string }>;
    }

  // ── Spine extension ──────────────────────────
  // Emitted by PoolContext.extendSpine whenever an orchestrator prefills
  // a user/assistant turn into the pool's spine. Carries enough to replay
  // the extension without cross-referencing other events.
  | TraceEventBase & {
      type: 'spine:extend';
      userContent: string;
      assistantContent: string;
      deltaTokens: number;
      positionAfter: number;
    }

  // ── Tool events ─────────────────────────────
  | TraceEventBase & {
      type: 'tool:dispatch';
      agentId: number;
      tool: string;
      toolIndex: number;
      toolkitSize: number;
      args: Record<string, unknown>;
      callId: string;
      explore: boolean;
      percentAvailable: number;
    }
  | TraceEventBase & {
      type: 'tool:result';
      agentId: number;
      tool: string;
      result: unknown;
      prefillTokenCount: number;
      durationMs: number;
    }
  // Fan-out determinism: the ORDERED tool results scatter-prefilled in one
  // SETTLE pass. Under inter-agent-concurrent dispatch, settle order = tool
  // completion order (network-timing dependent); recording it lets the replay
  // settle-order oracle reproduce the exact KV-prefill interleaving. On the
  // serial path it equals dispatch order; emitted uniformly either way.
  | TraceEventBase & {
      type: 'tool:settle_order';
      batch: Array<{ agentId: number; callId: string; tokenCount: number }>;
    }
  | TraceEventBase & { type: 'tool:error'; agentId: number; tool: string; error: string }
  // Transient tool failure (ToolRetryError — e.g. provider rate-limited).
  // The agent is parked (awaiting_tool) and the call re-executes after
  // retryAfterMs; nothing is settled into the agent's KV for this attempt.
  | TraceEventBase & {
      type: 'tool:retry';
      agentId: number;
      tool: string;
      callId: string;
      retryAfterMs: number;
      attempt: number;
    }
  // Protected tool call rejected at DISPATCH time by the framework-
  // injected authGuard: the session held no grant
  // for a `protected` tool. Emitted alongside the ordinary
  // `pool:agentNudge` so security tooling can detect attempted privileged
  // actions by `assignedAbility` × `attemptedTool` correlation without
  // scanning nudge-message free text.
  | TraceEventBase & {
      type: 'tool:authReject';
      agentId: number;
      /** Non-enforcing ability label (`SpawnSpec.assignedAbility`); null for harness-internal spawns. */
      assignedAbility: string | null;
      /** The protected tool the model attempted to call without a grant. */
      attemptedTool: string;
      /**
       * Flattened tool history across the rejecting agent's lineage
       * (self → caller → …) — the forensic correlation key for prompt
       * injection. Cheap to carry: `tool:authReject` is
       * rare-by-design (it fires only on an ungranted protected attempt).
       */
      lineageHistory: readonly ToolHistoryEntry[];
    }

  // ── Diverge events ──────────────────────────
  | TraceEventBase & { type: 'diverge:start'; attempts: number; prefixLength: number }
  | TraceEventBase & {
      type: 'diverge:end';
      bestIdx: number;
      ppls: number[];
      outputs: string[];
      totalTokens: number;
    }

  // ── BM25 first-stage events (corpus ability) ─────
  | TraceEventBase & {
      type: 'bm25:start';
      query: string;
      candidateCount: number;
      firstStageK: number;
    }
  | TraceEventBase & {
      type: 'bm25:end';
      candidateCount: number;
      keptCount: number;
      durationMs: number;
    }

  // ── Reranker events (rig package) ───────────
  | TraceEventBase & {
      type: 'rerank:start';
      query: string;
      chunkCount: number;
      tool?: string;
      url?: string;
      chunks?: Array<{ heading: string; textLength: number; startLine: number }>;
    }
  | TraceEventBase & {
      type: 'rerank:end';
      topResults: Array<{ file: string; heading: string; score: number; textPreview?: string }>;
      selectedPassageCount: number;
      totalChars: number;
      durationMs: number;
      tool?: string;
      url?: string;
      /** The admission gate's own parameters — budget mode. */
      topK?: number;
      tokenBudget?: number;
      /** Sum of admitted passage tokens (budget mode). */
      admittedTokens?: number;
      /** The admission gate's score floor — threshold mode. */
      threshold?: number;
      /** Candidates actually cross-encoded (the reranker's `total`). */
      totalScored?: number;
    }

  // ── Source events (rig package) ─────────────
  | TraceEventBase & { type: 'source:bind'; sourceName: string }
  | TraceEventBase & { type: 'source:research'; sourceName: string; questions: string[] }
  | TraceEventBase & { type: 'source:chunks'; sourceName: string; chunkCount: number }

  // ── Entailment scoring events ──────────────
  | TraceEventBase & { type: 'entailment:search'; tool: string; query: string; [key: string]: unknown }
  | TraceEventBase & { type: 'entailment:search:reordered'; tool: string; after: Array<{ title: string; url: string }> }
  | TraceEventBase & { type: 'entailment:delegate'; tool: string; callingAgentId?: number; callingAgentTaskLength?: number; callingAgentTask?: string; tasks: Array<{ text: string; score: number; kept: boolean }> }
  | TraceEventBase & { type: 'entailment:delegate:echo'; tool: string; agentTask: string; tasks: Array<{ text: string; echoScore: number }>; threshold: number; rejected: boolean }
  | TraceEventBase & {
      /** Exploit-mode dual scoring at a content boundary (search/fetch_page).
       *  Emitted when policy.shouldExplore() returns false and the tool
       *  applies scoreRelevanceBatch to tighten focus. */
      type: 'entailment:content:exploit';
      tool: string;
      /** Pressure snapshot that triggered exploit mode. Only the field the
       *  ability actually observes (`ToolContext.pressurePercentAvailable`)
       *  is recorded — a value it cannot see is OMITTED, never faked. */
      pressure: { percentAvailable?: number };
      /** Top chunks with both score flavors.
       *  toolQueryScore: reranker score against this tool call's query arg.
       *  combinedScore: min(toolQueryScore, originalQueryScore). */
      chunks: Array<{ heading: string; toolQueryScore: number; combinedScore: number }>;
    };
