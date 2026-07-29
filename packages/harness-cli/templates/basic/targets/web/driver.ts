/**
 * The served-host driver — the `config.ru` of the web target: the ONE file that
 * hands your harness to `@lloyal-labs/host`. It assembles the host's injected
 * `ServedHarness { materialise, run }` and drives a `ModelRuntimeHost` (ONE
 * resident model → N Sessions), exposing `serveConnection(socket)` to bind each
 * `ws` connection to a Session over binding's `wss()`.
 *
 * This is the canonical serving architecture every harness follows (the Rails
 * mapping: host = Puma, binding = Rack, this driver = config.ru). It matches
 * reasoning.run's `serve/driver.ts` — the production reference — one-for-one.
 *
 * **Eager-channels** resolves the ordering wrinkle: `wss()` needs the bus/commands
 * at bind time, but the host materialises the context asynchronously inside
 * `materialise`. The driver owns the seam, so it creates the channels per
 * connection (`createServedChannels`) and `materialise` returns those SAME
 * channels (looked up by `sessionId`) — the socket binds once, at connect time,
 * and the harness's events flow through the already-subscribed bus.
 *
 * **Harness-free by design:** this file imports only the harness-FREE served
 * factories (`createServedContext`/`createServedChannels`) + the host + `wss`. The
 * harness-running `run` is INJECTED — `serve.ts` supplies `runServedSession`
 * (which pulls the harness), a test could supply a fake — so the host imports no
 * harness, the harness imports no host, and this driver is the only file that
 * knows both.
 */
import { randomUUID } from "node:crypto";
import { resource } from "effection";
import type { Operation, Signal } from "effection";
import { createModelRuntimeHost } from "@lloyal-labs/host";
import type { Materialised, ServedHarness, SessionState } from "@lloyal-labs/host";
import { wss, type WsServerSocket } from "@lloyal-labs/binding/node";
import type { EventBus } from "@lloyal-labs/binding";
import type { SessionContext } from "@lloyal-labs/sdk";
import { createServedContext, createServedChannels } from "../../harness/served-runtime.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";
import type { Config } from "../../harness/config-types.js";

type Channels = { uiChannel: EventBus<WorkflowEvent>; commands: Signal<Command, void> };

export interface ServedHostDriverOpts {
  maxNativeSessions: number;
  /** Run one Session's harness over its substrate. `serve.ts` injects
   *  `runServedSession` (which pulls the harness); a test injects a fake. Kept
   *  INJECTED so this file stays harness-free + testable. */
  run: (m: Materialised<SessionContext>, sessionId: string) => Operation<void>;
  /** Build the per-session context over the resident model. Defaults to the
   *  served factory; a test overrides it with a fake (no model). */
  buildContext?: () => Promise<SessionContext>;
}

export interface ServedHostDriver {
  /** Bind one `ws` connection to a fresh Session. Call from `server.on("connection")`. */
  serveConnection(socket: WsServerSocket): void;
  /** Live-session occupancy (the host ledger — `sessions.size`). */
  readonly occupancy: number;
}

/**
 * Create the served-host driver as an Effection `resource`: the `ModelRuntimeHost`
 * lives for the resource's scope; unwinding it halts every Session + frees every
 * context.
 */
export function createServedHostDriver(
  cfg: Config,
  opts: ServedHostDriverOpts,
): Operation<ServedHostDriver> {
  return resource(function* (provide) {
    // Channels a connection stashes BEFORE admission; `materialise` CLAIMS them
    // (returns them AND removes the entry) so the socket (bound at connect time)
    // and the harness share one bus/command pair. So `pending` holds ONLY
    // not-yet-materialised sessions; the disconnect / terminal paths delete a
    // still-un-claimed entry.
    const pending = new Map<string, Channels>();
    const buildContext = opts.buildContext ?? (() => createServedContext(cfg));

    const served: ServedHarness<SessionContext> = {
      async materialise(sessionId: string): Promise<Materialised<SessionContext>> {
        const ch = pending.get(sessionId);
        if (!ch) throw new Error(`serve: no channels for session ${sessionId}`);
        pending.delete(sessionId); // claimed — the harness owns the channels now; a
        // repeat materialise of this id now fails loud above instead of reusing them.
        const context = await buildContext();
        return {
          context,
          uiChannel: ch.uiChannel,
          commands: ch.commands,
          dispose() {
            try {
              (context as { dispose?: () => void }).dispose?.();
            } catch {
              /* freeing the served context — not the driver's error to surface */
            }
          },
        };
      },
      run: opts.run,
    };

    const host = yield* createModelRuntimeHost<SessionContext>({
      served,
      maxNativeSessions: opts.maxNativeSessions,
    });

    function serveConnection(socket: WsServerSocket): void {
      const sessionId = randomUUID();
      // Defensive: an unhandled 'error' on a Node socket is thrown as an exception
      // — which would take the WHOLE serving process down (every other live Session
      // with it). The driver owns the wss binding, so it installs a no-op 'error'
      // handler here — every call site is protected by default, not just ones that
      // remember to attach one. (`WsServerSocket` doesn't declare 'error'; the real
      // `ws` socket has it — narrow-cast + optional-call.)
      (socket as unknown as { on?: (event: "error", cb: () => void) => void }).on?.("error", () => {});
      try {
        const { uiChannel, commands } = createServedChannels();
        pending.set(sessionId, { uiChannel, commands });
        // Bind the run plane NOW: events buffer on the bus until the harness
        // subscribes (EventBus replays to its first subscriber); `postSession`
        // writes the session plane.
        const postSession = wss<WorkflowEvent, Command>(socket, {
          uiChannel,
          dispatch: (c) => commands.send(c),
          bootstrap: [],
          sessionId,
        });
        // Client disconnect at ANY phase → release (queued=drop, warming=discard,
        // live=halt). `release()` returns the harness's halt promise, which CAN
        // reject (a teardown failure) — swallow it (matching the host's own
        // internal fire-and-forget cancel) so a disconnect can't surface as an
        // unhandled rejection. Do NOT delete `pending` here: if the disconnect
        // races the `warming` phase the host still completes `materialise`, and a
        // deleted stash would make it throw "no channels" → the host reports `died`
        // instead of a clean `reaped`. The stash is claimed by `materialise`, or
        // dropped by the terminal `reaped`/`died` in `onState` below.
        socket.on("close", () => {
          host.release(sessionId).catch(() => {});
        });
        host.admit({
          sessionId,
          onState: (s: SessionState) => {
            postSession(s);
            if (s.phase === "reaped" || s.phase === "died") pending.delete(sessionId);
          },
        });
      } catch (err) {
        // `serveConnection` runs inside the ws "connection" emit — a synchronous
        // setup failure here would escape into the emit and take the WHOLE host
        // down (every other live Session with it). Contain it to THIS connection:
        // free its slot, release any partial admission, best-effort close the
        // socket, and let the rest keep serving.
        pending.delete(sessionId);
        host.release(sessionId).catch(() => {});
        (socket as { close?: () => void }).close?.();
        console.error(
          `[serve] connection setup failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    yield* provide({
      serveConnection,
      get occupancy() {
        return host.occupancy;
      },
    });
  });
}
