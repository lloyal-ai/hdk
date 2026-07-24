/**
 * The CLI target — where your harness runs in a terminal.
 *
 * Generated for you and rarely touched. It does three things: resolve the
 * resident model, pick a surface, and run your harness over it. The surface
 * pick is the whole "one harness, many targets" idea in miniature — the same
 * `harness(ctx, events, commands)` mounts on Ink (a terminal), `ipc` (when a
 * desktop shell forks this bin), or `ndjson` (a pipe), all over one binding.
 *
 * `blank`'s edge is a single boot: no config-reload / model-restart loop
 * (that's a product's elaboration). The model is a file in `models/<role>/`,
 * resolved from `harness.yml` and — on first run — fetched + digest-verified by
 * the platform (`rig.resolveModel`), with no API key. Drop your own `.gguf`
 * into `models/llm/` (or point `path:` at one) to skip the fetch entirely.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { main, call, ensure, createSignal } from "effection";
import { createBus } from "@lloyal-labs/binding";
import { ipc, ndjson } from "@lloyal-labs/binding/node";
import { createContext } from "@lloyal-labs/lloyal.node";
import { resolveModel, provisionAppModels } from "@lloyal-labs/rig/node";
import { harness, apps } from "../../harness/harness.js";
import type { Command, WorkflowEvent } from "../../harness/protocol.js";
import { renderCli } from "./view.js";

interface ModelEntry {
  id?: string;
  path?: string;
  context?: number;
}
interface HarnessConfig {
  model?: { llm?: ModelEntry; reranker?: ModelEntry };
}

function loadConfig(): HarnessConfig {
  let raw: string;
  try {
    raw = readFileSync(join(process.cwd(), "harness.yml"), "utf8");
  } catch {
    process.stderr.write("harness.yml not found — run from your harness project root.\n");
    process.exit(1);
  }
  try {
    return (parse(raw) ?? {}) as HarnessConfig;
  } catch (err) {
    process.stderr.write(
      `harness.yml is not valid YAML: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

const config = loadConfig();
const llm: ModelEntry = config.model?.llm ?? {};
const context = llm.context ?? 32768;

main(function* () {
  // The resident model — a file in models/llm/, fetched + digest-verified on
  // first run (no API key). rig owns the verified fetch; the boot just asks.
  let modelPath: string;
  let fetching = false;
  try {
    modelPath = yield* call(() =>
      resolveModel({
        projectRoot: process.cwd(),
        role: "llm",
        spec: { id: llm.id, path: llm.path },
        onProgress: (got, total) => {
          fetching = true;
          const pct = total > 0 ? Math.round((100 * got) / total) : 0;
          process.stderr.write(`\rfetching ${llm.id ?? "model"} — ${pct}%   `);
        },
      }),
    );
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (fetching) process.stderr.write("\n");

  const ctx = yield* call(() =>
    createContext({
      modelPath,
      nCtx: context,
      nSeqMax: 32,
      typeK: "q4_0",
      typeV: "q4_0",
    }),
  );

  // Provision any auxiliary model an enabled app needs (a reranker, etc.) BEFORE
  // the harness enables its apps. No-op for the default (wikipedia needs none);
  // add a reranker-requiring app to `apps` and its model is fetched + verified
  // here, then injected via RerankerCtx.
  let fetchingReranker = false;
  try {
    yield* provisionAppModels({
      apps,
      projectRoot: process.cwd(),
      reranker: config.model?.reranker,
      onProgress: (got, total) => {
        fetchingReranker = true;
        const pct = total > 0 ? Math.round((100 * got) / total) : 0;
        process.stderr.write(`\rfetching reranker — ${pct}%   `);
      },
    });
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (fetchingReranker) process.stderr.write("\n");

  const events = createBus<WorkflowEvent>();
  const commands = createSignal<Command, void>();
  const dispatch = (c: Command): void => {
    commands.send(c);
  };
  const bootstrap: WorkflowEvent[] = [];

  // Surface pick — the same events/commands, a different binding. Each binding
  // returns a disposer; tie it to the scope so listeners are torn down on exit.
  let dispose: () => void;
  if (process.env.RR_BRIDGE) {
    // A desktop shell forked this bin: stream over the process channel.
    dispose = ipc<WorkflowEvent, Command>()(events, dispatch, bootstrap);
  } else if (process.stdout.isTTY) {
    // A terminal: mount the Ink view.
    dispose = renderCli(events, dispatch, bootstrap);
  } else {
    // A pipe: newline-delimited JSON.
    dispose = ndjson<WorkflowEvent, Command>()(events, dispatch, bootstrap);
  }
  yield* ensure(() => dispose());

  // Run the harness. Returns when it sees `quit` (or the scope unwinds).
  yield* harness(ctx, events, commands);
});
