import type { Operation } from 'effection';
import type { JsonSchema, ToolSchema, ToolContext } from './types';
import type { Agent } from './Agent';
import type { ContextPressure } from './pressure';
import { asAttachment } from '@lloyal-labs/media';
import type { Attachment } from '@lloyal-labs/media';

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
   * agents discover an ability's coverage by *trying*, the frontier-agentic
   * pattern. The spine loads every ability's tools once, shared by every agent;
   * an open tool is callable regardless of which ability a spawn nominally
   * belongs to.
   *
   * **Protected** (`true`): the tool mutates state or takes a consequential
   * action (transfer funds, file a ticket, send a message). The framework's
   * authGuard denies the call unless the session holds a **grant** for it
   * (held in {@link GrantStoreCtx}, acquired via consent — the model never
   * sees the credential). A denied attempt rejects at dispatch time and
   * emits `tool:authReject`.
   *
   * Trust changes *which grants a session holds*, never tool behaviour:
   * execution is identical for trusted and untrusted abilities. An ability MAY mark
   * an exfiltration-capable "read" (one that fetches arbitrary URLs) as
   * protected — the binary flag delegates that judgment to the ability.
   */
  readonly protected?: boolean;

  /**
   * Whether this tool is eligible for **fan-out** dispatch — running
   * concurrently with other agents' tool calls (and the pool's own generation),
   * instead of one at a time on the pool's loop.
   *
   * **Inline by default** (`false`/unset): the pool runs `execute()` itself and
   * waits for it. Safe for ANY tool, and REQUIRED for any tool that generates
   * on the **shared model** — anything that nests `agentPool` / `withSpine` /
   * `useAgent` (e.g. `delegate`, `plan`) or samples on the calling agent's
   * branch. Two concurrent generations on one model crash the process, so the
   * one-at-a-time discipline must hold for these.
   *
   * **Fan-out** (`true`): `execute()` never touches the shared model — only
   * network I/O, pure CPU, or a *separate* model (e.g. the reranker, which owns
   * its own and self-serializes). The pool runs it beside everything else so
   * one agent's slow/hung tool never stalls the others. Set this ONLY when that
   * holds: a wrong `true` is a crash, a wrong `false` is merely a waiting pool
   * — so the default is deliberately the safe one.
   */
  readonly fanout?: boolean;

  /**
   * What this tool says about the life of its own calls: its gates, its view of
   * a completion, of a result that does not fit, of a result just admitted.
   * Declared where `protected` and `fanout` are, so a subclass inherits it.
   * See {@link ToolLifecycleHooks}.
   */
  readonly hooks?: ToolLifecycleHooks;

  /**
   * Execute the tool with parsed arguments
   *
   * Called by the agent pool when the model emits a tool call matching
   * this tool's name. The return value is JSON-serialized and placed in the
   * agent's context as the tool result.
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

/*
 * ── The tool-lifecycle contract ─────────────────────────────────────────
 *
 * Everything a tool, a harness or the framework says about the life of a tool
 * call is a value of ONE type, `ToolLifecycleHooks`, whose members are the four
 * moments a call passes through the pool. The tool declares its value on
 * `Tool.hooks`; the harness contributes one through its policy; the framework's
 * own frame is one too. At each position the first concrete decision wins and
 * `undefined` abstains.
 */

/**
 * What the agent received in answer to a tool call: the tool's result, a nudge
 * in its place, or a recovery prompt.
 *
 * @category Agents
 */
export type Outcome = 'toolResult' | 'nudge' | 'recovery';

/**
 * One call, as a gate sees it.
 *
 * `attended()` is computed on demand: the arguments of this tool's earlier calls
 * whose results the agent attended, in the scope the harness chose — the agent's
 * own lineage unless the harness re-scoped the gate to the whole cohort. A gate
 * that decides without it never pays for it.
 *
 * @category Agents
 */
export interface GuardInput {
  tool: string;
  args: Record<string, unknown>;
  attended(): readonly Record<string, unknown>[];
}

/**
 * A gate on a tool call: may this call run.
 *
 * Declared by the tool that owns it (`Tool.hooks.beforeDispatch`) or contributed
 * by the harness through its policy. A gate that applies to some tools only
 * selects by `i.tool`.
 *
 * @category Agents
 */
export interface ToolGuard {
  /**
   * A published identifier: the key a harness overrides the gate by, and the
   * value on the trace. Renaming it is a breaking change for the ability.
   */
  name: string;
  /** `true` refuses the call. */
  reject(i: GuardInput): boolean;
  /** What the model reads when the call is refused. */
  message: string;
}

/**
 * How a call completed: the tool returned a value, or it threw.
 *
 * @category Agents
 */
export type Completion =
  | { kind: 'returned'; value: unknown }
  | { kind: 'threw'; error: Error };

/**
 * After a call completed: this was an attempt, or it is not one yet.
 *
 * @category Agents
 */
export type ExecuteDecision =
  | { type: 'attempt' }
  | { type: 'retry'; afterMs: number }
  | { type: 'fail'; message?: string };

/**
 * When a result does not fit and nothing can free room.
 *
 * @category Agents
 */
export type AdmitDecision =
  | { type: 'nudge'; message: string }
  | { type: 'drop' };

/**
 * After a result is admitted: a follow-up message the agent reads after it, or none.
 *
 * @category Agents
 */
export type FollowUp =
  | { type: 'followUp'; message: string }
  | { type: 'none' };

/**
 * Everything a contributor says about the life of a tool call, in one place.
 *
 * Four positions, one per moment a call passes through the pool. A tool
 * declares the ones it has an opinion about and leaves the rest to the harness
 * and the framework, which contribute values of this same type.
 *
 * @category Agents
 */
export interface ToolLifecycleHooks {
  /** May this call run. */
  beforeDispatch?: readonly ToolGuard[];

  /** The call completed. Is this an attempt, or not yet. `undefined` abstains. */
  afterExecute?(i: {
    agent: Agent;
    tool: string;
    args: Record<string, unknown>;
    attempt: number;
    completion: Completion;
  }): ExecuteDecision | undefined;

  /**
   * The result does not fit and nothing can free room. `cost` is what placing
   * it would spend, in the unit `pressure.headroom` reports room in (the unit
   * is defined on `ContextPressure`, once). `terminal` is the pool's terminal
   * tool, when it has one: whether the agent can be told to report instead.
   * `undefined` abstains.
   */
  beforeAdmit?(i: {
    agent: Agent;
    tool: string;
    args: Record<string, unknown>;
    cost: number;
    pressure: ContextPressure;
    terminal?: string;
  }): AdmitDecision | undefined;

  /**
   * The result is admitted and on the agent's ledger (a tool result is now in
   * `attendedResults`; a nudge is booked but not attended). `result` is what the
   * agent received: the tool's value, or a nudge's `{ error }`. Runs once per
   * admitted item, after admission, never for an item that is not admitted,
   * never for a recovery prompt. A hook that throws yields no follow-up and
   * cannot affect the admission. `undefined` abstains.
   */
  afterAdmit?(i: {
    agent: Agent;
    tool: string;
    args: Record<string, unknown>;
    outcome: Outcome;
    result: unknown;
  }): FollowUp | undefined;
}

/**
 * Thrown by a tool (or its backend provider) when the operation failed
 * transiently and should be retried after a delay — rate limiting being the
 * canonical case.
 *
 * The model never sees transient infrastructure weather: the agent waits, at
 * no cost to its turns or its context, and the same call runs again after
 * `retryAfterMs` — from the model's side the tool call just took longer. How
 * many times is an `afterExecute` decision (the tool's, the harness's, else
 * the framework's default of one retry), after which an honest "unavailable,
 * use other sources" result is placed in the tool's stead, because at that
 * point the outage is a fact the model needs in order to pivot.
 *
 * Observability: the pool emits `agent:tool_retry` and traces `tool:retry`
 * while the agent waits, so a waiting agent is never mistaken for a hung one.
 */
export class ToolRetryError extends Error {
  override readonly name = 'ToolRetryError';
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
  }
}

/*
 * ── The framework channel on a tool result ──────────────────────────────
 *
 * Three underscore-prefixed keys, named here rather than spelled inline, so
 * the convention has one home and a constant never drifts from a literal.
 *
 * The underscore marks AUTHORSHIP — the framework wrote this, not the tool —
 * and NOT invisibility. An earlier version of this comment said these are
 * "not something the model ever reads", which is false for two of the three
 * and mattered: it is the sentence that would talk a reader out of wording
 * `_imageError` carefully. They differ by DIRECTION:
 *
 * | key | direction | does the model read it? |
 * |---|---|---|
 * | `_attachments` | OUT of the result, before serializing | **no** — that is the point |
 * | `_contextAvailablePercent` | INTO the result | yes |
 * | `_imageError` | INTO the result | yes — it exists to be read |
 *
 * `_contextAvailablePercent` is an AMBIENT METER for the model: reaching it is
 * the point, and it carries how much of the context was free when the tool ran. Its
 * absence from any prompt is deliberate, not an oversight — the number travels
 * with every tool result and is meant to be read as one.
 */

/** The key a tool returns image bytes under.
 *
 *  Taken OUT before serializing, because images reach the model as images and
 *  must never reach it as JSON text. A 180 KB image stringifies to ~700k
 *  characters of digits, which is not a degraded result but a destroyed one.
 *
 *  An entry is raw bytes — admitted through the ingress door — or a root
 *  descriptor already in the content store (a page render a tool looked up, a
 *  document a tool fetched): no bytes, no door, the ingest-time digest. What
 *  the root materializes to decides how it is placed: as images when it has
 *  any; beside the tool's text, and booked as an asset available to the run,
 *  when it has none. */
export const TOOL_ATTACHMENTS_KEY = '_attachments';

/** Split a tool result into the images it carried and the result WITHOUT them.
 *
 *  Pure: it used to delete the key in place, which made the order of this call
 *  and the trace write decide what the trace said — the bytes must reach
 *  neither the model's JSON nor the trace, and an in-place delete leaves that
 *  as a property of call order rather than of the code. The caller names both
 *  halves and hands each to exactly one consumer.
 *
 *  `result` is returned unchanged when there is no media, so a text-only tool
 *  copies nothing. An entry is bytes or a root descriptor the store would
 *  recognise; anything else is ignored — markers are emitted per SURVIVING
 *  representation, so the prompt and the bitmap list stay in step whatever a
 *  tool hands over.
 *
 *  @category Agents
 */
export function takeToolMedia(
  result: unknown,
): { media: (Uint8Array | Attachment)[]; result: unknown } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { media: [], result };
  }
  if (!(TOOL_ATTACHMENTS_KEY in result)) return { media: [], result };
  const { [TOOL_ATTACHMENTS_KEY]: raw, ...rest } = result as Record<string, unknown>;
  // The reserved key never survives into the serialized result, even when its
  // value is malformed — returning the original would JSON-encode byte
  // indices into the model's prompt, the exact failure this helper exists to
  // prevent. An invalid value is simply zero media entries.
  const media: (Uint8Array | Attachment)[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry instanceof Uint8Array) { media.push(entry); continue; }
      const root = asAttachment(entry);
      if (root) media.push(root);
    }
  }
  return { media, result: rest };
}

/**
 * The key the framework INJECTS onto a tool result, carrying how much of the
 * context was free when the tool ran.
 *
 * @category Agents
 */
export const TOOL_CONTEXT_KEY = '_contextAvailablePercent';

/**
 * The key the framework INJECTS when a tool returned images this model cannot
 * see, carrying the reason.
 *
 * Written for the MODEL, which is what separates it from the other two: an
 * agent handed no picture and no explanation reasons confidently about
 * something it was never shown, and nothing downstream can tell that is what
 * happened. Same shape as the rate-limit `exhausted` path — an honest failure
 * in the result text rather than a silent drop.
 *
 * A constant for the reason the other two are: it was the one member of this
 * namespace still spelled as a bare literal at its write site.
 *
 * @category Agents
 */
export const TOOL_IMAGE_ERROR_KEY = '_imageError';
