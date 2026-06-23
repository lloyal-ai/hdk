import { Branch } from './Branch';
import type { BranchStore } from './BranchStore';
import type { SessionContext } from './types';
import { buildUserDelta, buildAssistantDelta, buildToolResultDelta, buildTurnDelta } from './deltas';

/**
 * Observer invoked after each trunk conversation prefill lands.
 *
 * Lets a consumer make the spine's accreting turns observable (e.g. the
 * agents-layer tracer emits a `branch:prefill` event) WITHOUT coupling
 * Session to any trace type — the callback is sdk-native. Pure
 * observability: it runs after the prefill and never affects it. `content`
 * is the verbatim turn text; `tokenCount` is the prefilled delta length.
 *
 * @category Branching
 */
export type TrunkPrefillObserver = (info: {
  role: 'user' | 'assistant' | 'turn' | 'tool';
  content: string;
  tokenCount: number;
  branchHandle: number;
}) => void;

/**
 * Session - Trunk lifecycle + conversation delta helpers
 *
 * Owns the current "trunk" branch and provides promote() to crown a winner,
 * plus delta helpers that centralize the sep + formatChat + tokenize + prefill
 * pattern for injecting new turns into an ongoing conversation.
 *
 * Session does NOT own the SessionContext or BranchStore — the consumer
 * creates those and passes them in. dispose() prunes trunk only.
 *
 * @example
 * ```typescript
 * const session = new Session({ ctx, store });
 * session.trunk = initialBranch;
 *
 * // After verification, promote the best attempt
 * await session.promote(bestAttempt.branch);
 *
 * // Inject a user turn and generate
 * await session.prefillUser('What about X?');
 * for await (const { text } of session.trunk) {
 *   process.stdout.write(text);
 * }
 *
 * // Cleanup
 * await session.dispose();
 * ctx.dispose();
 * ```
 *
 * @category Branching
 */
export class Session {
  private _ctx: SessionContext;
  private _store: BranchStore;
  private _trunk: Branch | null;
  private _onPrefill?: TrunkPrefillObserver;

  constructor({ ctx, store, onPrefill }: { ctx: SessionContext; store: BranchStore; onPrefill?: TrunkPrefillObserver }) {
    this._ctx = ctx;
    this._store = store;
    this._trunk = null;
    this._onPrefill = onPrefill;
  }

  /** Current trunk branch */
  get trunk(): Branch | null {
    return this._trunk;
  }

  /** Assign initial trunk (no promote) */
  set trunk(branch: Branch | null) {
    this._trunk = branch;
  }

  /**
   * Promote a winner to trunk — retainOnly + reassign
   *
   * Safe even if winner is the only branch (resets topology, no-op on KV).
   */
  async promote(winner: Branch): Promise<void> {
    await this._store.retainOnly(winner);
    this._trunk = winner;
  }

  /**
   * Dispose trunk only — consumer owns ctx and other resources
   */
  async dispose(): Promise<void> {
    if (this._trunk && !this._trunk.disposed) {
      await this._trunk.prune();
    }
    this._trunk = null;
  }

  /**
   * Prefill a user turn into trunk
   *
   * @param content - User message content
   * @param opts - Optional tools JSON string
   */
  async prefillUser(content: string, opts: { tools?: string } = {}): Promise<void> {
    const tokens = buildUserDelta(this._ctx, content, opts);
    await this._trunk!.prefill(tokens);
    this._onPrefill?.({ role: 'user', content, tokenCount: tokens.length, branchHandle: this._trunk!.handle });
  }

  /**
   * Prefill an assistant turn into trunk
   *
   * The assistant-side counterpart of {@link prefillUser}. Used to close a
   * dangling user turn — e.g. a consumer that earlier called `prefillUser`
   * to expose a message to a forked agent's KV (planner, research) and now
   * needs to commit the assistant response side without re-emitting the
   * user message.
   *
   * Requires a warm trunk; throws via `_trunk!` if trunk is null. For cold
   * bootstrap with both sides, use {@link commitTurn}.
   *
   * @param content - Assistant message content
   * @param opts - Optional thinking flag
   */
  async prefillAssistant(content: string, opts: { enableThinking?: boolean } = {}): Promise<void> {
    const tokens = buildAssistantDelta(this._ctx, content, opts);
    await this._trunk!.prefill(tokens);
    this._onPrefill?.({ role: 'assistant', content, tokenCount: tokens.length, branchHandle: this._trunk!.handle });
  }

  /**
   * Prefill a tool result turn into trunk
   *
   * @param resultStr - JSON-stringified tool result
   * @param callId - Tool call ID
   */
  async prefillToolResult(resultStr: string, callId: string): Promise<void> {
    const tokens = buildToolResultDelta(this._ctx, resultStr, callId);
    await this._trunk!.prefill(tokens);
    this._onPrefill?.({ role: 'tool', content: resultStr, tokenCount: tokens.length, branchHandle: this._trunk!.handle });
  }

  /**
   * Commit a query/response turn to the conversation trunk
   *
   * Handles warm/cold internally:
   * - **Warm** (trunk exists): appends turn separator + formatted delta to existing trunk
   * - **Cold** (no trunk): creates branch at position 0, prefills, promotes to trunk
   *
   * @param query - User message
   * @param response - Assistant response
   */
  async commitTurn(query: string, response: string): Promise<void> {
    if (this._trunk) {
      // Warm path: append turn delta (with separator) to existing trunk.
      // Explicit enableThinking:false — session trunk serializes completed
      // conversations; no thinking blocks should be embedded.
      const tokens = buildTurnDelta(this._ctx, query, response, { enableThinking: false });
      await this._trunk.prefill(tokens);
      this._onPrefill?.({ role: 'turn', content: `${query}\n\n${response}`, tokenCount: tokens.length, branchHandle: this._trunk.handle });
    } else {
      // Cold path: create trunk at position 0, prefill without separator
      // (fresh branch — no prior turn to separate from), then promote.
      const { prompt } = this._ctx.formatChatSync(
        JSON.stringify([
          { role: 'user', content: query },
          { role: 'assistant', content: response },
        ]),
        { enableThinking: false },
      );
      const tokens = this._ctx.tokenizeSync(prompt, false);
      const trunk = Branch.create(this._ctx, 0, {});
      await trunk.prefill(tokens);
      await this.promote(trunk);
      this._onPrefill?.({ role: 'turn', content: `${query}\n\n${response}`, tokenCount: tokens.length, branchHandle: trunk.handle });
    }
  }

  /**
   * Prefill the same content into trunk and a list of expert branches in one
   * batched dispatch.
   *
   * Used to align research agents to a new next-token task (e.g. "write the
   * synthesis report") before contrastive-decode synthesis. After this call,
   * every branch has fresh `logits_snapshot` reflecting its own KV history
   * plus the alignment tokens.
   *
   * @param content - Content to prefill (formatted as a user-role turn)
   * @param experts - Expert branches to align alongside trunk
   * @throws If trunk is not set
   */
  async prefillAligned(content: string, experts: Branch[]): Promise<void> {
    if (!this._trunk) {
      throw new Error('Session.prefillAligned: no trunk');
    }
    const tokens = buildUserDelta(this._ctx, content, {});
    const entries: [Branch, number[]][] = [
      [this._trunk, tokens],
      ...experts.map(e => [e, tokens] as [Branch, number[]]),
    ];
    await this._store.prefill(entries);
  }
}
