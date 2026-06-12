/**
 * `@lloyal-labs/wikipedia-app` — HDK reference app: Wikipedia research.
 *
 * Zero-arg factory: constructs a {@link WikipediaSource} that wraps two
 * public Wikipedia API endpoints — opensearch and REST page-summary —
 * and returns a validated {@link App}. No reranker, no config, no auth.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation } from "effection";
import type { App, AppManifest, Tool } from "@lloyal-labs/lloyal-agents";
import { defineApp } from "@lloyal-labs/rig";
import { WikipediaSource } from "./source";

export { WikipediaSource } from "./source";
export type { WikipediaSourceOpts } from "./source";

/**
 * Construct the Wikipedia research app. No configuration needed — the
 * Wikipedia public REST does not require auth.
 */
export function* createWikipediaApp(): Operation<App> {
  const dir = join(__dirname, "..");
  const manifest = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as AppManifest;
  const skill = readFileSync(join(dir, "skill.eta"), "utf8");

  const source = new WikipediaSource();
  const tools: Record<string, Tool> = {};
  for (const t of source.tools) tools[t.name] = t;

  return defineApp({ manifest, source, tools, skill });
}
