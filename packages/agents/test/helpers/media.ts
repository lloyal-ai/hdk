import type { Operation } from 'effection';
import { MockTool } from './mock-tool';
import { TOOL_MEDIA_KEY } from '../../src/Tool';
import type { AgentEvent } from '../../src/types';

/**
 * Shared media test fixtures.
 *
 * Extracted because they lived only inside `agent-pool.test.ts`, unexported, so
 * the invariants harness could not reach them — which is half of why the
 * invariants layer has no media coverage at all. One MediaTool, one fixture
 * byte-string, one failure filter, used by both.
 */

/** A tool returning image bytes under the framework's media key. */
export class MediaTool extends MockTool {
  constructor(private _bytes: Uint8Array[], name = 'rasterize') { super(name); }
  *execute(): Operation<unknown> {
    // Through the constant, like a real tool author would: a fixture spelling
    // the literal is a fixture that keeps passing after the key changes.
    return { page: 'p1', [TOOL_MEDIA_KEY]: this._bytes };
  }
}

/** A PNG header plus three bytes — enough for `sniffMediaType`, which reads
 *  magic bytes only. Not a decodable image: nothing in these tests decodes. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * The scaffold default (`harness.yml` → `model.llm.context`, and
 * `served-runtime.ts`'s `?? 32768`), so media tests run at the size real
 * harnesses do rather than at whatever number makes an assertion go green.
 */
export const MEDIA_TEST_NCTX = 32768;

/** Agents that failed specifically on the embedding rail. */
export const mediaFailures = (events: AgentEvent[]): AgentEvent[] =>
  events.filter(e => e.type === 'agent:failed'
    && (e as { reason?: string }).reason === 'media_prefill_failed');
