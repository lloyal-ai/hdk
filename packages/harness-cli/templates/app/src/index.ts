/**
 * `@__PUBLISHER__/__NAME__-app` — HDK app: __NAME__ research.
 *
 * Zero-arg factory. Reads the manifest from `app.json`, instantiates a
 * source + its tools, and returns a validated App for the registry.
 *
 * To customize for your domain: edit `useWhen` in `app.json`, the tool
 * `dispatch` bodies in `src/tools/`, and the per-spawn skill template
 * `skill.eta`. The factory shape itself almost never needs to change.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation } from "effection";
import type { App, AppManifest, Tool } from "@lloyal-labs/lloyal-agents";
import { defineApp } from "@lloyal-labs/rig";
import { __NAME_PASCAL__Source } from "./source";

export { __NAME_PASCAL__Source } from "./source";

/**
 * Construct the __NAME__ research app.
 */
export function* create__NAME_PASCAL__App(): Operation<App> {
  const dir = join(__dirname, "..");
  const manifest = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as AppManifest;
  const skill = readFileSync(join(dir, "skill.eta"), "utf8");

  const source = new __NAME_PASCAL__Source();
  const tools: Record<string, Tool> = {};
  for (const t of source.tools) tools[t.name] = t;

  return defineApp({ manifest, source, tools, skill });
}
