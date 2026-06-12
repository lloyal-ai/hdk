/**
 * __NAME__ — entry point.
 *
 * Boots a llama.cpp model context, builds an App registry, enables the
 * Wikipedia reference app, and runs a single research query against it.
 *
 * Usage:
 *   __NAME__ "<query>" [--model <path>] [--config <path>]
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { main, call } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import { initAgents } from "@lloyal-labs/lloyal-agents";
import { createInMemoryConfigStore, createAppRegistry } from "@lloyal-labs/rig";
import { createWikipediaApp } from "@lloyal-labs/wikipedia-app";
import { runQuery } from "./harness";

interface HarnessConfig {
  model: { path: string; nCtx?: number };
}

function loadConfig(configPath: string): HarnessConfig {
  if (!existsSync(configPath)) {
    return { model: { path: "", nCtx: 32768 } };
  }
  const raw = readFileSync(configPath, "utf8");
  return JSON.parse(raw) as HarnessConfig;
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string" },
    config: { type: "string" },
    "n-ctx": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  process.stdout.write(
    `Usage: __NAME__ "<query>" [--model <path>] [--config <path>] [--n-ctx <n>]\n`,
  );
  process.exit(values.help ? 0 : 1);
}

const query = positionals.join(" ");
const configPath = values.config ?? join(process.cwd(), "harness.json");
const config = loadConfig(configPath);
const modelPath = values.model ?? config.model.path;
const nCtx = values["n-ctx"]
  ? parseInt(values["n-ctx"], 10)
  : (config.model.nCtx ?? 32768);

if (!modelPath) {
  process.stderr.write(
    "No model path. Pass --model <path/to/model.gguf> or set model.path in harness.json.\n",
  );
  process.exit(1);
}
if (!existsSync(modelPath)) {
  process.stderr.write(`Model file not found: ${modelPath}\n`);
  process.exit(1);
}

main(function* () {
  process.stdout.write(`Loading model: ${modelPath}\n`);
  const ctx = yield* call(() =>
    createContext({
      modelPath,
      nCtx,
      nSeqMax: 32,
      typeK: "q4_0",
      typeV: "q4_0",
    }),
  );

  const { session } = yield* initAgents(ctx);

  const configStore = createInMemoryConfigStore();
  const registry = yield* createAppRegistry({ configStore });
  yield* registry.enable(createWikipediaApp);

  const answer = yield* runQuery(query, session);
  process.stdout.write("\n");
  process.stdout.write(answer);
  process.stdout.write("\n");
}).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
});
