/**
 * `@lloyal-labs/web-ability` — HDK reference ability: web research.
 *
 * Reads config from `AbilityConfigStoreCtx` and the harness's reranker,
 * constructs the {@link WebSource} already-bound (no `source.bind`), and
 * returns a validated {@link Ability}.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation } from "effection";
import { AbilityConfigStoreCtx } from "@lloyal-labs/rig";
import { service } from "@lloyal-labs/rig";
import type { Tool } from "@lloyal-labs/lloyal-agents";
import type { AbilityManifest } from "@lloyal-labs/rig";
import { defineAbility, TavilyProvider, createKeylessSearchProvider } from "@lloyal-labs/rig";
import type { SearchProvider } from "@lloyal-labs/rig";
import { WebSource } from "./source";
import type { WebSourceOpts } from "./source";

export { WebSource } from "./source";
export type { WebSourceOpts } from "./source";

// The declarative manifest + skill template, read once at module load. The
// manifest (with `services: ['reranker']`) rides the factory — so the harness
// provisions the reranker before enabling web research.
const dir = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(dir, "ability.json"), "utf8")) as AbilityManifest;
const skill = readFileSync(join(dir, "skill.eta"), "utf8");

/** The Tavily key as the stored config says it now, else the environment's. */
const tavilyKeyOf = (cfg: Record<string, unknown>): string | undefined =>
  typeof cfg.tavilyKey === "string" ? cfg.tavilyKey : process.env.TAVILY_API_KEY;

/**
 * Construct the web research ability. Provider selection: a `tavilyKey` in the
 * ability's stored config (or `TAVILY_API_KEY`) → Tavily; otherwise a keyless
 * DuckDuckGo provider. The key is read AT EACH SEARCH, so a key saved while a run
 * is live reaches the next search of every agent already holding the tool; the
 * keyless provider owns a pacer and is built once here, only when no key is
 * stored at enable. `services: ['reranker']` is the requirement: a harness whose
 * `model.reranker` block is absent does not enable this ability, so the reranker
 * below is always present.
 */
export const createWebAbility = defineAbility(manifest, function* () {
  const cfgStore = yield* AbilityConfigStoreCtx.expect();
  const cfg = (yield* cfgStore.get(manifest.name)) ?? {};
  const reranker = yield* service('reranker');

  const keyless: SearchProvider | undefined = tavilyKeyOf(cfg) ? undefined : yield* createKeylessSearchProvider();
  const provider = function* (): Operation<SearchProvider> {
    const key = tavilyKeyOf((yield* cfgStore.get(manifest.name)) ?? {});
    if (key) return new TavilyProvider(key);
    if (keyless) return keyless;
    throw new Error("web search: the Tavily key was removed, and this build started without keyless search — save the web settings again");
  };

  // The source's knobs, when the stored config carries them; the source's defaults otherwise.
  const topN = typeof cfg.topN === "number" ? cfg.topN : undefined;
  const fetch = cfg.fetch && typeof cfg.fetch === "object" && !Array.isArray(cfg.fetch) ? (cfg.fetch as WebSourceOpts["fetch"]) : undefined;
  const source = new WebSource(provider, { reranker, topN, fetch });
  const tools: Record<string, Tool> = {};
  for (const t of source.tools) tools[t.name] = t;

  return { source, tools, skill };
});
