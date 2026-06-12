/**
 * `GrantStore` — pluggable runtime store for protected-tool grants.
 *
 * A **grant** authorizes the current session to invoke a `protected` tool
 * (see {@link Tool.protected}). The framework's authGuard denies any
 * protected tool call whose name is not granted. Grants are obtained via
 * consent — a harness consent prompt, or an app's {@link ConfigFlow}
 * OAuth-style handoff — and the **credential itself never enters the
 * model's context**: the model only triggers the call; the runtime holds
 * the grant and the tool's `execute` uses the underlying secret.
 *
 * The interface lives in `@lloyal-labs/lloyal-agents` so the framework
 * context ({@link GrantStoreCtx}) and app/harness code share one type
 * without a dependency cycle. The concrete in-memory implementation
 * (`createGrantStore`) and harness-supplied backends live in rig and
 * harness packages — mirroring {@link AppConfigStore} /
 * `createInMemoryConfigStore`.
 *
 * **Semantics:**
 *
 * - **Binary per tool.** A grant is keyed by tool name; either the session
 *   holds it or it doesn't. No scopes, no expiry in the base contract —
 *   richer policies are a harness concern.
 * - **Fail-closed.** With no grant store on {@link GrantStoreCtx}, no grants
 *   exist: every protected tool is denied. Open (non-protected) tools are
 *   unaffected.
 *
 * @packageDocumentation
 * @category Contract
 */

import type { Operation } from 'effection';

/**
 * Pluggable runtime store of protected-tool grants for a session.
 *
 * All methods return `Operation<...>` (Effection generators) so concrete
 * implementations can perform async IO (reading a secrets backend,
 * checking a remote authorization service) inside the framework's scope.
 */
export interface GrantStore {
  /** Whether the session currently holds a grant for `toolName`. */
  has(toolName: string): Operation<boolean>;
  /** Record consent for `toolName` (the session may now call it). Idempotent. */
  grant(toolName: string): Operation<void>;
  /** Revoke a previously-granted tool. Idempotent. */
  revoke(toolName: string): Operation<void>;
  /** Snapshot of all granted tool names — the synchronous gate the pool reads. */
  granted(): Operation<readonly string[]>;
}
