/**
 * `@lloyal-labs/web-ability` — HDK reference ability: web research.
 *
 * Reads config from `AbilityConfigStoreCtx` and the shared reranker from
 * `RerankerCtx`, constructs the {@link WebSource} already-bound (no
 * `source.bind`), and returns a validated {@link Ability}.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AbilityConfigStoreCtx, RerankerCtx } from "@lloyal-labs/lloyal-agents";
import type { AbilityManifest, Tool } from "@lloyal-labs/lloyal-agents";
import { defineAbility, TavilyProvider, createKeylessSearchProvider } from "@lloyal-labs/rig";
import type { Reranker, SearchProvider } from "@lloyal-labs/rig";
import { WebSource } from "./source";

export { WebSource } from "./source";
export type { WebSourceOpts } from "./source";

// The declarative manifest + skill template, read once at module load. The
// manifest (with `services: ['reranker']`) rides the factory — so the harness
// provisions the reranker before enabling web research.
const dir = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(dir, "ability.json"), "utf8")) as AbilityManifest;
const skill = readFileSync(join(dir, "skill.eta"), "utf8");

/**
 * Construct the web research ability. Provider selection: a `tavilyKey` in the
 * ability's stored config (or `TAVILY_API_KEY`) → Tavily; otherwise a keyless
 * DuckDuckGo provider. `services: ['reranker']` makes the harness provision +
 * set `RerankerCtx` before this runs, so the reranker is always present — the
 * `catch` below stays only as a defensive guard.
 */
export const createWebAbility = defineAbility(manifest, function* () {
  const cfgStore = yield* AbilityConfigStoreCtx.expect();
  const cfg = (yield* cfgStore.get("web")) ?? {};
  const tavilyKey =
    typeof cfg.tavilyKey === "string" ? cfg.tavilyKey : process.env.TAVILY_API_KEY;

  let reranker: Reranker | undefined;
  try {
    reranker = yield* RerankerCtx.expect();
  } catch {
    reranker = undefined;
  }

  const provider: SearchProvider = tavilyKey
    ? new TavilyProvider(tavilyKey)
    : yield* createKeylessSearchProvider();

  const source = new WebSource(provider, { reranker });
  const tools: Record<string, Tool> = {};
  for (const t of source.tools) tools[t.name] = t;

  return { source, tools, skill };
});
