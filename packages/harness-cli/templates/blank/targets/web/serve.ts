/**
 * The web target's boot — the `serve/main.ts` of the canonical serving
 * architecture. It resolves the resident model, hands the harness to the host via
 * the DRIVER (`createServedHostDriver`), and stands up the `ws` front door.
 *
 * The split is deliberate and matches reasoning.run (the production reference):
 * the host (`@lloyal-labs/host`) imports no harness; the harness
 * (`harness/harness.ts`) imports no host; the DRIVER (`./driver.ts`) is the only
 * file that knows both — this boot just wires config + the socket to it. It's the
 * SAME `harness(ctx, events, commands)` the cli and desktop run; only the binding
 * (wss, here) differs.
 *
 * `npm run serve` builds + starts this; then `npm run dev:web` serves the browser
 * app that talks to it. Config from `harness.yml` + env (PORT / HOST /
 * MAX_SESSIONS). Loopback + no-auth for local dev — TLS/auth terminate upstream.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main, suspend, call } from "effection";
import type { Signal } from "effection";
import { WebSocketServer } from "ws";
import type { WsServerSocket } from "@lloyal-labs/binding/node";
import type { EventBus } from "@lloyal-labs/binding";
import { resolveModel } from "@lloyal-labs/rig/node";
import { parse } from "yaml";
import { createServedHostDriver } from "./driver.js";
import { apps } from "../../harness/harness.js";
import { runServedSession } from "../../harness/served-session.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";
import type { Config } from "../../harness/config-types.js";

interface ModelEntry {
  id?: string;
  path?: string;
  context?: number;
}

function loadConfig(): { model?: { llm?: ModelEntry; reranker?: ModelEntry } } {
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

const config = loadConfig();
const llm: ModelEntry = config.model?.llm ?? {};
const reranker: ModelEntry = config.model?.reranker ?? {};
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 4;

main(function* () {
  // Resolve the resident model ONCE (fetched + digest-verified on first run, no
  // key). Every Session's context is created over this one path → shared weights.
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

  // Resolve the reranker to a concrete path ONLY if an enabled app declares the
  // service — the default wikipedia app needs none, so we skip the ~630 MB fetch.
  // resolveModel honors a harness.yml pin (id or path) and digest-verifies on
  // first run, so `cfg.model.reranker` is then always a resolved PATH (never a
  // bare id) — the per-session provisioning below uses it as-is.
  let rerankerPath: string | undefined;
  const needsReranker = apps.some((a) => (a.manifest?.services ?? []).includes("reranker"));
  if (needsReranker) {
    rerankerPath = yield* call(() =>
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
  }

  // The live config the harness reads via RunnerCtx (built into a per-session
  // Runner inside runServedSession). Every Session's context is created over the
  // one resident model; the reranker (if any) is loaded per-session by
  // provisionAppModels from this resolved path.
  const cfg: Config = {
    version: 1,
    sources: {},
    apps: {},
    model: { path: modelPath, reranker: rerankerPath, nCtx: llm.context ?? 32768 },
  };

  // Hand the harness to the host through the driver. The host is payload-opaque
  // (bus/command types erased to `unknown`); the harness created them as
  // WorkflowEvent/Command, so re-narrow them inside `run`.
  const driver = yield* createServedHostDriver(cfg, {
    maxNativeSessions: MAX_SESSIONS,
    run: (m) =>
      runServedSession(
        cfg,
        m.context,
        m.uiChannel as unknown as EventBus<WorkflowEvent>,
        m.commands as unknown as Signal<Command, void>,
      ),
  });

  const server = new WebSocketServer({ port: PORT, host: HOST });
  server.on("error", (err: NodeJS.ErrnoException) => {
    process.stderr.write(`\nserve: failed to bind ${HOST}:${PORT} — ${err.code ?? err.message}\n`);
    process.exit(1);
  });
  server.on("connection", (socket) => {
    // The driver installs the socket's no-op 'error' handler itself (an unhandled
    // 'error' on a Node EventEmitter throws), so the boot just hands the socket off.
    driver.serveConnection(socket as unknown as WsServerSocket);
  });
  process.stderr.write(
    `\n__NAME__ serving on ws://${HOST}:${PORT} — up to ${MAX_SESSIONS} browser session(s) over one resident model.\n`,
  );
  yield* suspend();
});
