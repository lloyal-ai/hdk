import type { Operation } from 'effection';
import { DOCUMENT_CONFIG_TYPE } from '@lloyal-labs/media';
import type { Attachment, AttachmentStore } from '@lloyal-labs/media';
import { MockTool } from './mock-tool';
import { TOOL_ATTACHMENTS_KEY } from '../../src/Tool';
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
    return { page: 'p1', [TOOL_ATTACHMENTS_KEY]: this._bytes };
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

/** A tool returning attachment ROOTS under the same key — what a tool that
 *  reads the content store hands back: descriptors, no bytes, no ingress. */
export class RootTool extends MockTool {
  constructor(private _roots: readonly Attachment[], name = 'view') { super(name); }
  *execute(): Operation<unknown> {
    return { page: 'p1', [TOOL_ATTACHMENTS_KEY]: this._roots };
  }
}

/** An image root: one PNG representation — the shape a page render has.
 *  Materializes to one bitmap. */
export function imageRoot(store: AttachmentStore, bytes: Uint8Array = PNG_BYTES): Attachment {
  return store.putAttachment({ representations: [store.putBlob(bytes, 'image/png')] });
}

/** A document root: one `text/markdown` representation and the document
 *  sidecar as config. Materializes to NO bitmaps — that is the property the
 *  rail tests lean on; the sidecar's content is the media package's affair. */
export function documentRoot(store: AttachmentStore, title = 'A Paper'): Attachment {
  const markdown = new TextEncoder().encode(`# ${title}\n\nBody.\n`);
  const sidecar = {
    title, pageCount: 1,
    sections: [{ heading: title, path: title, origin: 'heuristic', startLine: 1, endLine: 3, pageStart: 1, pageEnd: 1 }],
    pages: [{ page: 1, startLine: 1, endLine: 3, chars: 5, imageObjects: 0, pathObjects: 0, taggedTables: 0, taggedFigures: 0 }],
    figures: [], tables: [],
    derive: { profile: 'pdf.v1', pdfium: 'test', dpi: 150, maxSide: 2048, maxPixels: 1, format: 'image/png',
      renderedPages: 0, maxFigures: 16, maxTextPages: 400, tagged: false, structCoverage: 0, truncated: false },
  };
  return store.putAttachment({
    representations: [store.putBlob(markdown, 'text/markdown')],
    config: { bytes: new TextEncoder().encode(JSON.stringify(sidecar)), mediaType: DOCUMENT_CONFIG_TYPE },
  });
}
