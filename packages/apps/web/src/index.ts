/**
 * `@lloyal-labs/web-app` — HDK reference app: web research.
 *
 * Zero-arg factory: reads config from `AppConfigStoreCtx` and
 * the shared reranker from `RerankerCtx`, constructs the {@link WebSource}
 * already-bound (no `source.bind`), and returns a validated {@link App}.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation } from "effection";
import { AppConfigStoreCtx, RerankerCtx } from "@lloyal-labs/lloyal-agents";
import type { App, AppManifest, Tool } from "@lloyal-labs/lloyal-agents";
import { defineApp, TavilyProvider, createKeylessSearchProvider } from "@lloyal-labs/rig";
import type { Reranker, SearchProvider } from "@lloyal-labs/rig";
import { WebSource } from "./source";

export { WebSource } from "./source";
export type { WebSourceOpts } from "./source";

/**
 * Construct the web research app. Provider selection: a `tavilyKey` in the
 * app's stored config (or `TAVILY_API_KEY`) → Tavily; otherwise a keyless
 * DuckDuckGo provider. The reranker (if any) is read from `RerankerCtx` and
 * injected into the source at construction.
 */
export function* createWebApp(): Operation<App> {
  const dir = join(__dirname, "..");
  const manifest = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as AppManifest;
  const skill = readFileSync(join(dir, "skill.eta"), "utf8");

  const cfgStore = yield* AppConfigStoreCtx.expect();
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

  return defineApp({ manifest, source, tools, skill });
}
