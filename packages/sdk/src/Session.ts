import { Branch } from './Branch';
import type { BranchStore } from './BranchStore';
import type { SessionContext } from './types';
import { buildUserDelta, buildUserDeltaMultimodal, buildAssistantDelta, buildToolResultDelta, buildTurnDelta } from './deltas';

/**
 * Observer invoked after each trunk conversation prefill lands.
 *
 * Lets a consumer make the spine's accreting turns observable (e.g. the
 * agents-layer tracer emits a `branch:prefill` event) WITHOUT coupling
 * Session to any trace type — the callback is sdk-native. Pure
 * observability: it runs after the prefill and never affects it. `content`
 * is the verbatim turn text; `cells` is what the prefill added to the cache.
 *
 * @category Branching
 */
export type TrunkPrefillObserver = (info: {
  role: 'user' | 'assistant' | 'turn' | 'tool';
  content: string;
  /** KV CELLS the prefill added — not tokens.
   *
   *  Equal on the token rail, where this is the delta length. NOT equal on the
   *  multimodal path, which reports `tokensDecoded` — itself documented as
   *  "KV cells added", a name inherited from the native contract and shared
   *  with lloyal.node, so it cannot be corrected from here. This field is
   *  sdk-native and can be, so it is. */
  cells: number;
  branchHandle: number;
  /** Roots of the content this prefill put into the cache, in marker order —
   *  present only on the multimodal path.
   *
   *  Descriptors, NOT bytes: by the time a prefill happens the caller has
   *  already normalized and committed the content, because media that reaches
   *  the cache unaddressed produces a run that cannot be replayed. So there is
   *  nothing left to store here — only a reference to record. Structural on
   *  purpose: the SDK has no attachment concept and does not want one. */
  attachments?: readonly { digest: string; mediaType: string; size: number }[];
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
    this._onPrefill?.({ role: 'user', content, cells: tokens.length, branchHandle: this._trunk!.handle });
  }

  /**
   * Prefill a user turn with images into trunk
   *
   * The multimodal counterpart of {@link prefillUser}: same composition,
   * with one media marker per image in the user content. The images land
   * as a shared prefix on the trunk — a spine forked from it (and every
   * agent forked from the spine) attends them with zero re-encode.
   *
   * Requires a context created with `mmprojPath`.
   *
   * Handles warm/cold internally, like {@link commitTurn} and unlike
   * {@link prefillUser}:
   * - **Warm** (trunk exists): appends separator + delta to the existing trunk
   * - **Cold** (no trunk): creates a branch at position 0, prefills WITHOUT a
   *   separator (fresh branch — no prior turn to separate from), promotes it
   *
   * The cold path is what a composer needs. An image attached to the FIRST
   * question has no trunk yet, and the trunk is otherwise not established
   * until a run ends; without this the image could only reach the model as a
   * per-agent copy. Landing it on the trunk first is what lets every agent
   * forked from it attend the same encoded rows.
   *
   * @param content - User message text
   * @param images - Encoded image bytes in a format the projector decodes
   * @param opts - Optional tools JSON string
   */
  async prefillUserMultimodal(
    content: string,
    images: Uint8Array[],
    opts: {
      tools?: string;
      /** Roots for the content in `images`, already committed by the caller's
       *  barrier. Passed through to the prefill observer so the trace records
       *  what was admitted; the Session itself never inspects them. */
      attachments?: readonly { digest: string; mediaType: string; size: number }[];
    } = {},
  ): Promise<void> {
    const { sep, prompt, bitmaps } = buildUserDeltaMultimodal(this._ctx, content, images, opts);
    const attachments = opts.attachments;
    if (this._trunk) {
      const { tokensDecoded } = await this._trunk.prefillMultimodal(prompt, bitmaps, sep);
      this._onPrefill?.({ role: 'user', content, cells: tokensDecoded, branchHandle: this._trunk.handle, ...(attachments ? { attachments } : {}) });
    } else {
      const trunk = Branch.create(this._ctx, 0, {});
      const { tokensDecoded } = await trunk.prefillMultimodal(prompt, bitmaps, []);
      await this.promote(trunk);
      this._onPrefill?.({ role: 'user', content, cells: tokensDecoded, branchHandle: trunk.handle, ...(attachments ? { attachments } : {}) });
    }
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
    this._onPrefill?.({ role: 'assistant', content, cells: tokens.length, branchHandle: this._trunk!.handle });
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
    this._onPrefill?.({ role: 'tool', content: resultStr, cells: tokens.length, branchHandle: this._trunk!.handle });
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
      this._onPrefill?.({ role: 'turn', content: `${query}\n\n${response}`, cells: tokens.length, branchHandle: this._trunk.handle });
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
      this._onPrefill?.({ role: 'turn', content: `${query}\n\n${response}`, cells: tokens.length, branchHandle: trunk.handle });
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
