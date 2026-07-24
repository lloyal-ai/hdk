/**
 * `@__PUBLISHER__/__NAME__-app` — HDK app: __NAME__ research.
 *
 * An app = its declarative manifest (`app.json`) + a `setup` that constructs the
 * runtime pieces. `defineApp` pairs them and returns the factory the harness
 * enables; it also advertises the manifest, so the harness can provision any
 * models you declare in `services` (e.g. a reranker) before enabling.
 *
 * To customize for your domain: edit `app.json` (name, `useWhen`, `services`),
 * the tool `dispatch` bodies in `src/tools/`, and the per-spawn skill template
 * `skill.eta`.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppManifest, Tool } from "@lloyal-labs/lloyal-agents";
import { defineApp } from "@lloyal-labs/rig";
import { __NAME_PASCAL__Source } from "./source";

export { __NAME_PASCAL__Source } from "./source";

// The declarative manifest + skill template, read once at module load.
const dir = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as AppManifest;
const skill = readFileSync(join(dir, "skill.eta"), "utf8");

/**
 * Construct the __NAME__ research app. The setup reads any config/services it
 * needs, builds the source + tools, and returns them; `defineApp` validates and
 * assembles the App when the harness enables it.
 */
export const create__NAME_PASCAL__App = defineApp(manifest, function* () {
  const source = new __NAME_PASCAL__Source();
  const tools: Record<string, Tool> = {};
  for (const t of source.tools) tools[t.name] = t;

  return { source, tools, skill };
});
