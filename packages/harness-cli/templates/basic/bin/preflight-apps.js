#!/usr/bin/env node
/**
 * Fail fast, naming the command that fixes it, when an AgentApp this harness
 * imports was never vendored.
 *
 * `harness/harness.ts` imports its apps at the top level, so a scaffold made
 * with `--skip-apps` — or one whose fetch failed — cannot typecheck. Without
 * this guard `npm start` dies inside `tsc` with a bare TS2307: the compiler
 * complaining about a supply problem. Running ahead of the compiler puts the
 * `harness.dev install` line in front of the user instead.
 *
 * Both truth sources are in package.json, and the CLI writes both:
 *
 *   harnessdev.apps        the install specs `harness.dev new` recorded
 *   dependencies[<name>]   `file:vendor/<publisher>__<name>-<version>.tgz`,
 *                          written by verifyAndVendorApp → setFileDependency
 *                          (harness-cli/src/scaffold/vendor-app.ts)
 *
 * A spec is satisfied when some dependency points at its vendored tarball. That
 * `vendor/<flat>-<version>.tgz` shape is the ONE thing this script assumes about
 * the CLI — keep it in sync with vendor-app.ts if it ever changes.
 *
 * Deliberately narrow: this checks only that the apps were VENDORED. "Vendored
 * but never npm-installed" is left to `bin/run.js`, which sees the real
 * resolution failure and so cannot guess wrong about it.
 */
import { readFileSync } from "node:fs";

const pkg = readPkg();
const specs = recordedSpecs(pkg);

// An absent/empty `apps` marker means UNKNOWN, never "none" (see the contract in
// harness-cli/src/scaffold/write-marker.ts). Blocking here would break any
// project that predates the marker or was written by hand.
if (specs.length === 0) process.exit(0);

const vendored = new Set(
  Object.values(pkg.dependencies ?? {}).filter(
    (v) => typeof v === "string" && v.startsWith("file:vendor/"),
  ),
);

const missing = specs.filter((spec) => {
  const want = expectedVendorDep(spec);
  return want !== null && !vendored.has(want);
});

if (missing.length) {
  const plural = missing.length > 1;
  process.stderr.write(
    `\nThis harness imports ${plural ? "AgentApps that are" : "an AgentApp that is"} not installed.\n` +
      "Fetch the signed (Ed25519-verified) bundles, then try again:\n\n" +
      `${missing.map((spec) => `  npx harness.dev install ${spec}`).join("\n")}\n\n`,
  );
  process.exit(1);
}

/** The `harness.dev install` specs `harness.dev new` recorded for this project. */
function recordedSpecs(pkg) {
  const apps = pkg.harnessdev?.apps;
  return Array.isArray(apps) ? apps.filter((a) => typeof a === "string") : [];
}

/** `lloyal/web@1.3.0` → `file:vendor/lloyal__web-1.3.0.tgz`. */
function expectedVendorDep(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null; // unpinned or unparseable — never call it missing
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!name.includes("/") || !version) return null;
  return `file:vendor/${name.replace("/", "__")}-${version}.tgz`;
}

function readPkg() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
}
