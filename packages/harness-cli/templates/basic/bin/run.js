#!/usr/bin/env node
// Boot the built cli target. The one failure worth translating here is a MISSING
// AgentApp: harness/harness.ts imports its apps at the top level, so a project
// whose apps were never fetched dies on this import with a bare
// ERR_MODULE_NOT_FOUND stack. Name the command that fixes it instead.
import { readFileSync } from "node:fs";

try {
  await import("../dist/targets/cli/index.js");
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  process.stderr.write(`\n${err.message}\n`);
  const specs = appSpecs();
  process.stderr.write(
    "\nThis harness imports AgentApps that are not installed. Fetch the signed\n" +
      "(Ed25519-verified) bundles, then start again:\n\n",
  );
  for (const spec of specs.length ? specs : ["<publisher>/<name>"]) {
    process.stderr.write(`  npx harness.dev install ${spec}\n`);
  }
  process.stderr.write("\n");
  process.exit(1);
}

/** The `harness.dev install` specs `harness.dev new` recorded for this project. */
function appSpecs() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const apps = pkg.harnessdev?.apps;
    return Array.isArray(apps) ? apps.filter((a) => typeof a === "string") : [];
  } catch {
    return [];
  }
}
