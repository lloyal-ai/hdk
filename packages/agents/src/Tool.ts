import type { Operation } from 'effection';
import type { JsonSchema, ToolSchema, ToolContext } from './types';

/**
 * Abstract base class for tools usable by agents in the runtime
 *
 * Subclass to define tools that agents can invoke during generation.
 * Implement `name`, `description`, `parameters`, and `execute()`. The
 * {@link schema} getter auto-generates the OpenAI-compatible function
 * schema expected by `formatChat()`.
 *
 * Pass tool instances to {@link createToolkit} to build the `toolMap`
 * and `toolsJson` pair consumed by {@link useAgentPool} and
 * {@link runAgents}.
 *
 * `execute()` returns an Effection `Operation`, enabling tools to
 * spawn sub-agents via {@link agentPool} or {@link withSpine}.
 * For async work, wrap in `call()`. For synchronous tools, return
 * directly from the generator body.
 *
 * @example Search tool
 * ```typescript
 * class SearchTool extends Tool<{ query: string; topK?: number }> {
 *   readonly name = 'search';
 *   readonly description = 'Search the corpus for relevant passages';
 *   readonly parameters = {
 *     type: 'object',
 *     properties: {
 *       query: { type: 'string', description: 'Search query' },
 *       topK: { type: 'number', description: 'Number of results' },
 *     },
 *     required: ['query'],
 *   };
 *
 *   *execute(args: { query: string; topK?: number }, ctx?: ToolContext): Operation<unknown> {
 *     const results = yield* call(() => this.reranker.rank(args.query, args.topK ?? 5));
 *     return { results };
 *   }
 * }
 * ```
 *
 * @category Agents
 */
// `TArgs` defaults to `any` (not `Record<string, unknown>`) so heterogeneous
// `Tool` subclasses — each with its own `execute(args: TArgs)` shape — assign to
// a uniform `Tool[]` / `Record<string, Tool>` without an `as unknown as Tool[]`
// cast. `TArgs` sits in a contravariant (parameter) position; `any` is the
// variance-neutral default. Authors still narrow `TArgs` per tool for safety.
export abstract class Tool<TArgs = any> {
  /** Tool name — used as the function identifier in tool calls */
  abstract readonly name: string;
  /** Human-readable description shown to the model */
  abstract readonly description: string;
  /** JSON Schema describing the tool's expected arguments */
  abstract readonly parameters: JsonSchema;

  /**
   * Whether invoking this tool requires authorization.
   *
   * **Open by default** (`false`/unset): any agent may call the tool. This
   * is the right setting for read/gather tools — search, fetch, grep — where
   * agents discover an app's coverage by *trying*, the frontier-agentic
   * pattern. The spine loads every app's tools for KV amortization; an open
   * tool is callable regardless of which app a spawn nominally belongs to.
   *
   * **Protected** (`true`): the tool mutates state or takes a consequential
   * action (transfer funds, file a ticket, send a message). The framework's
   * authGuard denies the call unless the session holds a **grant** for it
   * (held in {@link GrantStoreCtx}, acquired via consent — the model never
   * sees the credential). A denied attempt rejects at dispatch time and
   * emits `tool:authReject`.
   *
   * Trust changes *which grants a session holds*, never tool behaviour:
   * execution is identical for trusted and untrusted apps. An app MAY mark
   * an exfiltration-capable "read" (one that fetches arbitrary URLs) as
   * protected — the binary flag delegates that judgment to the app.
   */
  readonly protected?: boolean;

  /**
   * Whether this tool is eligible for **fan-out** dispatch — running on a
   * child fiber concurrently with other agents' tool calls (and the pool's
   * own decode), instead of inline on the single tick-loop fiber.
   *
   * **Inline by default** (`false`/unset): the pool `await`s `execute()` on
   * the loop fiber. Safe for ANY tool, and REQUIRED for any tool that issues
   * a native op on the **main** `llama_context` — anything that nests
   * `agentPool` / `withSpine` / `useAgent` (e.g. `delegate`, `plan`) or
   * decodes on `context.branch`. Two concurrent decodes on one context
   * segfault, so the single-fiber discipline must hold for these.
   *
   * **Fan-out** (`true`): `execute()` issues NO native op on the main context
   * — only network I/O, pure CPU, or a *separate* context (e.g. the reranker,
   * which owns its own and self-serializes). The pool spawns it off the loop
   * fiber so one agent's slow/hung tool never stalls the others; completions
   * drain back on-fiber. Set this ONLY when the no-main-context-decode
   * invariant holds: a wrong `true` is a segfault, a wrong `false` is merely a
   * parked loop — so the default is deliberately the safe one.
   */
  readonly fanout?: boolean;

  /**
   * Execute the tool with parsed arguments
   *
   * Called by the agent pool when the model emits a tool call matching
   * this tool's name. The return value is JSON-serialized and prefilled
   * back into the agent's context as a tool result.
   *
   * Returns an Effection Operation — implement as a generator method.
   * The operation runs inside the agent pool's scope, so it has access
   * to Ctx, Store, and Events contexts for nested agent spawning.
   *
   * @param args - Parsed arguments from the model's tool call
   * @param context - Execution context with progress reporting callback
   * @returns Tool result (will be JSON-serialized)
   */
  abstract execute(args: TArgs, context?: ToolContext): Operation<unknown>;

  /**
   * Optional reasoning probe prefilled after this tool's result settles.
   *
   * When set, the pool prefills this text into the agent's context after
   * the tool result, before the lazy grammar resets. This nudges the model
   * to reason in prose about the result before generating the next tool call.
   *
   * Receives the tool result so the probe can be conditional — return null
   * to skip.
   *
   * @param result - The tool result that was prefilled
   * @returns Probe text to prefill, or null to skip
   */
  probe(_result: unknown): string | null { return null; }

  /**
   * OpenAI-compatible function tool schema
   *
   * Auto-generated from `name`, `description`, and `parameters`.
   * Used by {@link createToolkit} to build the JSON string passed
   * to `formatChat()`.
   */
  get schema(): ToolSchema {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}

/**
 * Thrown by a tool (or its backend provider) when the operation failed
 * transiently and should be retried after a delay — rate limiting being the
 * canonical case.
 *
 * The pool's DISPATCH phase catches this BEFORE the generic tool-error
 * handler: instead of settling an error into the agent's KV, it parks the
 * agent (`awaiting_tool` — skipped by PRODUCE at zero cost) and re-executes
 * the same call after `retryAfterMs`. The model never sees transient
 * infrastructure weather in its context; from its side the tool call just
 * took longer. One retry is budgeted — a second ToolRetryError settles an
 * honest "unavailable, use other sources" result, because at that point the
 * outage is a fact the model needs in order to pivot.
 *
 * Observability: the pool emits `agent:tool_retry` (TUI) and `tool:retry`
 * (trace) when parking, so a waiting agent is never mistaken for a hung one.
 */
export class ToolRetryError extends Error {
  override readonly name = 'ToolRetryError';
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
  }
}
