/**
 * `@lloyal-labs/corpus-ability` — HDK reference ability: local-corpus research.
 *
 * Requires a reranker (its `search` tool scores chunks); loads the corpus and
 * fits it into reranker-sized windows at construction, and returns a validated {@link Ability} whose
 * {@link CorpusSource} is already-bound.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { call } from "effection";
import { AbilityConfigStoreCtx, RerankerCtx } from "@lloyal-labs/lloyal-agents";
import type { AbilityManifest, Tool } from "@lloyal-labs/lloyal-agents";
import { defineAbility, fitChunks, DEFAULT_CHUNK_TOKENS } from "@lloyal-labs/rig";
import type { Reranker } from "@lloyal-labs/rig";
import { loadResources, chunkResources } from "@lloyal-labs/rig/node";
import { CorpusSource } from "./source";

export { CorpusSource } from "./source";
export type { CorpusSourceOpts, CorpusPromptData } from "./source";

// The declarative manifest + skill template, read once at module load. The
// manifest is handed to defineAbility, which advertises it on the factory — so the
// harness boot reads `services: ['reranker']` and provisions before enabling.
const dir = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(dir, "ability.json"), "utf8")) as AbilityManifest;
const skill = readFileSync(join(dir, "skill.eta"), "utf8");

/**
 * Construct the corpus research ability. Reads `corpusPath` from the ability's stored
 * config, loads + chunks the corpus, tokenizes the chunks through the shared
 * reranker (from `RerankerCtx`), and wires the three corpus tools.
 *
 * `services: ['reranker']` (from `ability.json`) rides the factory's manifest, so
 * the harness provisions + sets `RerankerCtx` before this runs — the
 * `RerankerCtx.expect()` below is a guaranteed read, not a gamble.
 */
export const createCorpusAbility = defineAbility(manifest, function* () {
  let reranker: Reranker;
  try {
    reranker = yield* RerankerCtx.expect();
  } catch {
    throw new Error(
      "createCorpusAbility: the corpus ability requires a reranker (its `search` tool scores " +
        "chunks), but RerankerCtx is unset. The harness boot normally provisions it from " +
        "the ability's `services: ['reranker']` — call provisionAbilityModels({ abilities, projectRoot }) " +
        "(or otherwise set RerankerCtx) before enabling this ability.",
    );
  }

  const cfgStore = yield* AbilityConfigStoreCtx.expect();
  const cfg = (yield* cfgStore.get("corpus")) ?? {};
  const corpusPath = typeof cfg.corpusPath === "string" ? cfg.corpusPath : undefined;
  if (!corpusPath) {
    throw new Error(
      "createCorpusAbility: missing config `corpusPath`. Set it via " +
        "configStore.set('corpus', { corpusPath }) before enabling.",
    );
  }

  const resources = loadResources(corpusPath);
  // Sections become windows the reranker scores whole; the size is a retrieval
  // choice (see DEFAULT_CHUNK_TOKENS), the tokens are the reranker's own.
  const chunks = yield* call(() =>
    fitChunks(chunkResources(resources), { maxTokens: DEFAULT_CHUNK_TOKENS, tokenize: (t) => reranker.tokenize(t) }),
  );

  const source = new CorpusSource(resources, chunks, reranker);
  const tools: Record<string, Tool> = {};
  for (const t of source.tools) tools[t.name] = t;

  return { source, tools, skill };
});
