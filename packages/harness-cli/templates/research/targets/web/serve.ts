/**
 * `bin/serve.js`'s entry — the web target's served-host runner. Stands up a `ws`
 * server that serves N browser Sessions over ONE resident model (the model-runtime
 * host + the wss front door in one process). It's the SAME
 * `harness(ctx, events, commands)` the cli and desktop run — only the binding differs;
 * the browser connects with `connectWss` (see `web-bridge.ts`).
 *
 * `npm run serve` builds + starts this; then `npm run dev:web` serves the browser
 * app that talks to it. Loopback + no-auth for local dev — token auth is a
 * front-door concern, deferred.
 *
 * ESBUILT (it injects `runServedSession` → the harness → its `.eta` prompts, so it
 * must bundle with `--loader:.eta=text`, never tsx).
 *
 * ONE adaptation over reasoning.run's env-sourced `serve/main.ts`: the **config
 * source**. Instead of `LLOYAL_MODEL`/`LLOYAL_RERANKER` env vars, `resolveConfig`
 * reads `harness.yml` and resolves the llm + reranker specs to concrete
 * digest-verified `.gguf` paths via rig's `resolveModel` (batteries included, no env
 * needed). Everything else — `createServedHostDriver`, `createModelRuntimeHost`, the
 * `ws` WebSocketServer, the wss per-connection binding, admit/release — is
 * reasoning.run's serving code verbatim.
 *
 * SNAPSHOT: reasoning.run @ 0.8.0 (src/serve/main.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { main, suspend, call } from "effection";
import type { Operation, Signal } from "effection";
import { WebSocketServer } from "ws";
import type { WsServerSocket } from "@lloyal-labs/binding/node";
import type { EventBus } from "@lloyal-labs/binding";
import { resolveModel } from "@lloyal-labs/rig/node";
import { createServedHostDriver } from "./driver.js";
import { runServedSession } from "../../harness/served-session.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";
import type { Config } from "../../harness/config-types.js";

interface ModelEntry {
  id?: string;
  path?: string;
  context?: number;
}

function loadYaml(): { model?: { llm?: ModelEntry; reranker?: ModelEntry } } {
  // Fail loud, like the cli boot: a missing or malformed harness.yml must not be
  // silently swallowed into `{}` (which would fall through to default model
  // resolution and serve an unexpected model).
  let raw: string;
  try {
    raw = readFileSync(join(process.cwd(), "harness.yml"), "utf8");
  } catch {
    process.stderr.write("harness.yml not found — run `npm run serve` from your harness project root.\n");
    process.exit(1);
  }
  try {
    return (parse(raw) ?? {}) as { model?: { llm?: ModelEntry; reranker?: ModelEntry } };
  } catch (err) {
    process.stderr.write(
      `harness.yml is not valid YAML: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The web target's config source (the sole adaptation over reasoning.run's
 * env-sourced `resolveConfig`): read `harness.yml`, then resolve the llm + reranker
 * specs to concrete verified `.gguf` paths via rig's `resolveModel` (fetched +
 * digest-verified on first run, no key). The served factories read `model.path`
 * (+ `model.nCtx`) for the resident context and `model.reranker` for the per-session
 * cross-encoder.
 */
function* resolveConfig(): Operation<Config> {
  const yaml = loadYaml();
  const llm: ModelEntry = yaml.model?.llm ?? {};
  const reranker: ModelEntry = yaml.model?.reranker ?? {};

  // Resolve the resident reasoning model ONCE → every Session's context is created
  // over this one path (shared weights, weak-cached by lloyal.node's ModelRegistry).
  const modelPath = yield* call(() =>
    resolveModel({
      projectRoot: process.cwd(),
      role: "llm",
      spec: { id: llm.id, path: llm.path },
      onProgress: (got, total) => {
        const pct = total > 0 ? Math.round((100 * got) / total) : 0;
        process.stderr.write(`\rfetching ${llm.id ?? "model"} — ${pct}%   `);
      },
    }),
  );

  // Resolve the reranker the same verified way. Its weights are resident too (shared
  // across Sessions); each Session gets its OWN KV context over them.
  const rerankerPath = yield* call(() =>
    resolveModel({
      projectRoot: process.cwd(),
      role: "reranker",
      spec: { id: reranker.id, path: reranker.path },
      onProgress: (got, total) => {
        const pct = total > 0 ? Math.round((100 * got) / total) : 0;
        process.stderr.write(`\rfetching reranker — ${pct}%   `);
      },
    }),
  );

  return {
    version: 1,
    sources: {},
    apps: {},
    defaults: { reasoningMode: "flat", effort: "high", maxTurns: 10 },
    model: { path: modelPath, reranker: rerankerPath, nCtx: llm.context ?? 32768 },
  };
}

main(function* () {
  const cfg = yield* resolveConfig();
  const port = envInt("PORT", 8787);
  const maxNativeSessions = envInt("MAX_SESSIONS", 8);
  // Default to loopback: the pilot is no-auth, and ws's default all-interfaces bind for
  // `{ port }` would expose an unauthenticated model service on the LAN. `HOST=0.0.0.0`
  // is an explicit opt-in once an operator fronts it with auth/TLS.
  const bindHost = process.env.HOST ?? "127.0.0.1";

  const driver = yield* createServedHostDriver(cfg, {
    maxNativeSessions,
    // The host is payload-opaque — it erases the bus/command types to `unknown`. The
    // driver created these channels as WorkflowEvent/Command, so re-narrow them here.
    run: (m) =>
      runServedSession(
        cfg,
        m.context,
        m.uiChannel as unknown as EventBus<WorkflowEvent>,
        m.commands as unknown as Signal<Command, void>,
      ),
  });

  const server = new WebSocketServer({ port, host: bindHost });
  // Server-level errors are almost always a bind failure (EADDRINUSE / EACCES). Without a
  // listener Node rethrows the EventEmitter 'error' as an uncaught exception with a bare
  // stack — surface an actionable message + exit non-zero for the operator/orchestrator.
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[serve] failed to bind ${bindHost}:${port} — ${err.code ?? err.message}`);
    process.exit(1);
  });
  server.on("connection", (socket) => {
    // The driver installs the socket's no-op 'error' handler itself (an unhandled
    // 'error' on a Node EventEmitter throws), so the boot just hands the socket off.
    driver.serveConnection(socket as unknown as WsServerSocket);
  });
  // Plaintext ws:// — TLS terminates upstream (reverse proxy / the managed front door),
  // never in this process, so label it "ws" (not "wss") for operators.
  console.log(
    `\n__NAME__ serving on ws://${bindHost}:${port} — up to ${maxNativeSessions} browser session(s) over ${cfg.model.path}`,
  );

  yield* suspend(); // run until the process is signalled (main handles SIGINT/SIGTERM)
});
