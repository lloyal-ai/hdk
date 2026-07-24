/**
 * `@lloyal-labs/corpus-app` — HDK reference app: local-corpus research.
 *
 * Zero-arg factory: requires a reranker (its `search` tool scores
 * chunks), loads + tokenizes the corpus at construction, and returns a
 * validated {@link App} whose {@link CorpusSource} is already-bound.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { call } from "effection";
import type { Operation } from "effection";
import { AppConfigStoreCtx, RerankerCtx } from "@lloyal-labs/lloyal-agents";
import type { App, AppFactory, AppManifest, Tool } from "@lloyal-labs/lloyal-agents";
import { defineApp } from "@lloyal-labs/rig";
import type { Reranker } from "@lloyal-labs/rig";
import { loadResources, chunkResources } from "@lloyal-labs/rig/node";
import { CorpusSource } from "./source";

export { CorpusSource } from "./source";
export type { CorpusSourceOpts, CorpusPromptData } from "./source";
export { BM25Index } from "./bm25";
export type { Bm25Opts, Bm25Hit } from "./bm25";

// Read the declarative manifest + skill template once, at module load, so the
// factory can expose `requires` statically: the harness boot reads it BEFORE
// running the factory, to provision the reranker this app needs.
const dir = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as AppManifest;
const skill = readFileSync(join(dir, "skill.eta"), "utf8");

/**
 * Construct the corpus research app. Reads `corpusPath` from the app's stored
 * config, loads + chunks the corpus, tokenizes the chunks through the shared
 * reranker (from `RerankerCtx`), and wires the three corpus tools.
 *
 * `requires: ['reranker']` (from `app.json`) is attached to the factory, so the
 * harness provisions + sets `RerankerCtx` before this runs — the
 * `RerankerCtx.expect()` below is then a guaranteed read, not a gamble.
 */
export const createCorpusApp: AppFactory = Object.assign(
  function* (): Operation<App> {
    let reranker: Reranker;
    try {
      reranker = yield* RerankerCtx.expect();
    } catch {
      throw new Error(
        "createCorpusApp: the corpus app requires a reranker (its `search` tool scores " +
          "chunks). Set RerankerCtx via createReranker(...) before enabling.",
      );
    }

    const cfgStore = yield* AppConfigStoreCtx.expect();
    const cfg = (yield* cfgStore.get("corpus")) ?? {};
    const corpusPath = typeof cfg.corpusPath === "string" ? cfg.corpusPath : undefined;
    if (!corpusPath) {
      throw new Error(
        "createCorpusApp: missing config `corpusPath`. Set it via " +
          "configStore.set('corpus', { corpusPath }) before enabling.",
      );
    }

    const resources = loadResources(corpusPath);
    const chunks = chunkResources(resources);
    yield* call(() => reranker.tokenizeChunks(chunks));

    const source = new CorpusSource(resources, chunks, reranker);
    const tools: Record<string, Tool> = {};
    for (const t of source.tools) tools[t.name] = t;

    return defineApp({ manifest, source, tools, skill });
  },
  { requires: manifest.requires ?? [] },
);
