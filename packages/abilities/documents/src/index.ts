/**
 * `@lloyal-labs/documents-ability` — HDK reference ability: research over the
 * documents attached to a conversation.
 *
 * Documents reach the ability as the assets available to a run: every tool
 * reads `ToolContext.attachments` at the call and indexes what is there, once
 * per digest. The table of contents the harness places on the spine comes
 * from `Source.promptData(attachments)`. Nothing here touches the native
 * addon or a node-only entry of a sibling package.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RerankerCtx, Attachments } from '@lloyal-labs/lloyal-agents';
import type { AbilityManifest, Tool } from '@lloyal-labs/lloyal-agents';
import { defineAbility } from '@lloyal-labs/rig';
import type { Reranker } from '@lloyal-labs/rig';
import { DocumentsSource } from './source';
import { documentIndexer } from './documents-index';
import { SearchDocumentsTool } from './tools/search-documents';
import { ReadDocumentTool } from './tools/read-document';
import { ViewPageTool } from './tools/view-page';

export { DocumentsSource, buildToc } from './source';
export type { DocumentsPromptData } from './source';
export { documentIndexer, documentId, pageCite, NO_DOCUMENTS } from './documents-index';
export type { DocumentsIndex, IndexedDocument } from './documents-index';
export { SearchDocumentsTool, locate } from './tools/search-documents';
export type { DocumentHit, IndexFor } from './tools/search-documents';
export { ReadDocumentTool } from './tools/read-document';
export { ViewPageTool, projectable } from './tools/view-page';

// The declarative manifest + skill template, read once at module load and
// handed to defineAbility, which advertises the manifest on the factory.
const dir = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(dir, 'ability.json'), 'utf8')) as AbilityManifest;
const skill = readFileSync(join(dir, 'skill.eta'), 'utf8');

/**
 * Construct the documents ability. Reads the reranker from `RerankerCtx` and
 * the content store from `Attachments`, builds the per-session indexer, and
 * wires the three tools. Under `lloyal describe` the default store answers
 * null and the ability is simply empty.
 */
export const createDocumentsAbility = defineAbility(manifest, function* () {
  let reranker: Reranker;
  try {
    reranker = yield* RerankerCtx.expect();
  } catch {
    throw new Error(
      'createDocumentsAbility: the documents ability requires a reranker (its `search_documents` tool ' +
        'scores passages), but RerankerCtx is unset. The harness boot normally provisions it from ' +
        "the ability's `services: ['reranker']` — call provisionAbilityModels({ abilities, projectRoot }) " +
        '(or otherwise set RerankerCtx) before enabling this ability.',
    );
  }
  const store = yield* Attachments.expect();
  const indexFor = documentIndexer(store, (text) => reranker.tokenize(text));
  const tools: Tool[] = [
    new SearchDocumentsTool(indexFor, reranker),
    new ReadDocumentTool(indexFor),
    new ViewPageTool(indexFor),
  ];
  const source = new DocumentsSource(store, tools, reranker);
  const byName: Record<string, Tool> = {};
  for (const t of tools) byName[t.name] = t;
  return { source, tools: byName, skill };
});
