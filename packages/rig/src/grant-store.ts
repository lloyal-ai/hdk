/**
 * In-memory implementation of {@link GrantStore} — RFC §3.2 M2, §7.2.
 *
 * The `GrantStore` interface itself lives in `@lloyal-labs/lloyal-agents`
 * (so the framework context `GrantStoreCtx` and app/harness code share it
 * without a dependency cycle). This module supplies the reference impl that
 * dev harnesses, examples, and tests use; harnesses that back grants with
 * a secrets manager or remote authorization service implement the
 * interface themselves.
 *
 * A grant records that the session has obtained consent to invoke a
 * `protected` tool (see {@link Tool.protected}). The **credential** behind
 * that consent (an OAuth token, an API key) is the harness's concern and
 * never enters the model's context — this store holds only the binary
 * decision the authGuard reads.
 *
 * @packageDocumentation
 * @category Contract
 */

import type { Operation } from 'effection';
import type { GrantStore } from '@lloyal-labs/lloyal-agents';

/**
 * Create an in-memory `GrantStore` backed by a `Set`.
 *
 * Intended for development, tests, and single-process harnesses. Pass
 * `initial` to pre-grant a set of protected tools at construction (a
 * harness that has already obtained consent, or a test fixture).
 * Harnesses needing durable or audited grants implement the interface
 * themselves against their preferred backend.
 */
export function createGrantStore(initial?: Iterable<string>): GrantStore {
  const grants = new Set<string>(initial);
  return {
    *has(toolName: string): Operation<boolean> {
      return grants.has(toolName);
    },
    *grant(toolName: string): Operation<void> {
      grants.add(toolName);
    },
    *revoke(toolName: string): Operation<void> {
      grants.delete(toolName);
    },
    *granted(): Operation<readonly string[]> {
      return [...grants];
    },
  };
}
