/**
 * The web target's host — serves your harness to browsers over wss.
 *
 * Stands up a `ws` server that runs N browser Sessions over ONE resident model:
 * `@lloyal-labs/host`'s `ModelRuntimeHost` weak-caches the weights, so each
 * Session gets only its own KV context + event bus. Each connection binds to a
 * Session via binding's `wss()`; the browser connects with `connectWss` (see
 * `web-bridge.ts`). It's the SAME `harness(ctx, events, commands)` the cli and
 * desktop run — only the binding differs.
 *
 * `npm run serve` builds + starts this; then `npm run dev:web` serves the
 * browser app that talks to it. Config from `harness.yml` + env (PORT / HOST /
 * MAX_SESSIONS). Loopback + no-auth for local dev.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { main, suspend, call, createSignal, type Signal } from "effection";
import { WebSocketServer } from "ws";
import { createBus, type EventBus } from "@lloyal-labs/binding";
import { wss, type WsServerSocket } from "@lloyal-labs/binding/node";
import {
  createModelRuntimeHost,
  type Materialised,
  type ServedHarness,
  type SessionState,
} from "@lloyal-labs/host";
import { createContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import { resolveModel, provisionAppModels } from "@lloyal-labs/rig/node";
import { harness, apps } from "../../harness/harness.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";

interface ModelEntry {
  id?: string;
  path?: string;
  context?: number;
}

function loadConfig(): { model?: { llm?: ModelEntry; reranker?: ModelEntry } } {
  try {
    return (parse(readFileSync(join(process.cwd(), "harness.yml"), "utf8")) ?? {}) as {
      model?: { llm?: ModelEntry; reranker?: ModelEntry };
    };
  } catch {
    return {};
  }
}

const config = loadConfig();
const llm: ModelEntry = config.model?.llm ?? {};
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 4;

type Channels = { uiChannel: EventBus<WorkflowEvent>; commands: Signal<Command, void> };

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

  // Channels a connection stashes BEFORE admission; `materialise` claims them so
  // the socket (bound at connect time) and the harness share one bus/command pair.
  const pending = new Map<string, Channels>();

  const served: ServedHarness<SessionContext> = {
    async materialise(sessionId: string): Promise<Materialised<SessionContext>> {
      const ch = pending.get(sessionId);
      if (!ch) throw new Error(`serve: no channels for session ${sessionId}`);
      pending.delete(sessionId);
      const context = (await createContext({
        modelPath,
        nCtx: llm.context ?? 32768,
        nSeqMax: 32,
        typeK: "q4_0",
        typeV: "q4_0",
      })) as unknown as SessionContext;
      return {
        context,
        uiChannel: ch.uiChannel,
        commands: ch.commands,
        dispose() {
          try {
            (context as { dispose?: () => void }).dispose?.();
          } catch {
            /* freeing the session context — not the host's error to surface */
          }
        },
      };
    },
    *run(m: Materialised<SessionContext>) {
      // Runner-less: provision the enabled apps' services (a no-op unless an app
      // needs a reranker) into THIS session's scope, then run the harness.
      yield* provisionAppModels({ apps, projectRoot: process.cwd() });
      yield* harness(
        m.context,
        m.uiChannel as EventBus<WorkflowEvent>,
        m.commands as Signal<Command, void>,
      );
    },
  };

  const host = yield* createModelRuntimeHost<SessionContext>({
    served,
    maxNativeSessions: MAX_SESSIONS,
  });

  const server = new WebSocketServer({ port: PORT, host: HOST });
  server.on("error", (err: Error) => {
    process.stderr.write(`\nserve: ws server error — ${err.message}\n`);
    process.exit(1);
  });
  server.on("connection", (socket) => {
    socket.on("error", () => {});
    const sessionId = randomUUID();
    try {
      const uiChannel = createBus<WorkflowEvent>();
      const commands = createSignal<Command, void>();
      pending.set(sessionId, { uiChannel, commands });
      // Bind the socket NOW — events buffer on the bus until the harness subscribes.
      const postSession = wss<WorkflowEvent, Command>(socket as unknown as WsServerSocket, {
        uiChannel,
        dispatch: (c) => commands.send(c),
        bootstrap: [],
        sessionId,
      });
      // Disconnect at any phase → release (queued=drop, warming=discard, live=halt).
      socket.on("close", () => {
        host.release(sessionId).catch(() => {});
        pending.delete(sessionId);
      });
      host.admit({
        sessionId,
        onState: (s: SessionState) => {
          postSession(s);
          if (s.phase === "reaped" || s.phase === "died") pending.delete(sessionId);
        },
      });
    } catch (err) {
      // Contain a synchronous setup failure to THIS connection — never take the
      // whole host down with it.
      pending.delete(sessionId);
      host.release(sessionId).catch(() => {});
      (socket as { close?: () => void }).close?.();
      process.stderr.write(`serve: connection setup failed — ${String(err)}\n`);
    }
  });
  process.stderr.write(
    `\n__NAME__ serving on ws://${HOST}:${PORT} — up to ${MAX_SESSIONS} browser session(s) over one resident model.\n`,
  );
  yield* suspend();
});
