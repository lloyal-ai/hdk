#!/usr/bin/env node
// Boot the built cli target.
//
// One failure here is worth translating rather than dumping: a MISSING AgentApp.
// harness/harness.ts imports its apps at the top level, so a project whose apps
// were never fetched dies on this import with a bare ERR_MODULE_NOT_FOUND stack.
// But that SAME code covers an unbuilt dist/ and any un-installed dependency, so
// classify the unresolved specifier before naming a fix — advice for the wrong
// problem is worse than no advice.
import { readFileSync } from "node:fs";

try {
  await import("../dist/targets/cli/index.mjs");
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  process.stderr.write(`\n${err.message}\n\n${diagnose(err)}\n`);
  process.exit(1);
}

/**
 * Turn an ERR_MODULE_NOT_FOUND into the command that fixes it.
 *
 * Node names the unresolved specifier in the message — `Cannot find package 'x'`
 * for a bare specifier, `Cannot find module '/abs/path'` for a path. A path can
 * only be our own build output. A bare specifier is a dependency, and whether it
 * is an un-vendored AgentApp or a dep that was simply never installed is decided
 * by package.json.
 */
function diagnose(err) {
  const pkg = readPkg();
  const specifier = /Cannot find (?:package|module) '([^']+)'/.exec(err.message)?.[1];

  // Unrecognized message shape: offer every fix, claim none of them.
  if (!specifier) {
    return [
      "Something this project imports could not be resolved. Usually one of:",
      "",
      "  npm install",
      "  npm run build",
      ...installLines(pkg),
    ].join("\n");
  }

  if (specifier.startsWith("/") || specifier.startsWith(".") || specifier.startsWith("file:")) {
    return ["This project is not built yet:", "", "  npm run build"].join("\n");
  }

  if (pkg.dependencies?.[specifier] != null || pkg.devDependencies?.[specifier] != null) {
    return [`\`${specifier}\` is a dependency but is not installed:`, "", "  npm install"].join(
      "\n",
    );
  }

  return [
    `\`${specifier}\` is not a dependency of this project.`,
    "This harness imports AgentApps at the top level — fetch the signed",
    "(Ed25519-verified) bundles, then start again:",
    "",
    ...installLines(pkg),
  ].join("\n");
}

/** The `harness.dev install` specs `harness.dev new` recorded for this project. */
function installLines(pkg) {
  const apps = pkg.harnessdev?.apps;
  const specs = Array.isArray(apps) ? apps.filter((a) => typeof a === "string") : [];
  return (specs.length ? specs : ["<publisher>/<name>"]).map(
    (spec) => `  npx harness.dev install ${spec}`,
  );
}

function readPkg() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
}
