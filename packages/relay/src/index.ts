/**
 * @lloyal-labs/relay — the self-hostable framework-relay.
 *
 * A persisted Node server that serves a headless harness to remote frontends over
 * `wss` — the self-host serving front door. It is **harness-agnostic**: it forks
 * ANY deployable harness bin and serves ANY static frontend, so a deploy tool can
 * provision it as a wrapper rather than a rewrite.
 *
 * This module is the reusable glue. Option-A serving (one model residency per
 * connection): each connection forks its own harness child and bridges that
 * child's fork-IPC `BindingFrame`s ⇄ the wss socket. (Option B — N Sessions
 * sharing one in-process residency — uses `@lloyal-labs/binding`'s `wss`
 * against per-Session buses instead; that is the compute-strand's host.)
 */

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  BindingFrame,
  SessionFrame,
  SessionState,
  RoutedBindingFrame,
} from "@lloyal-labs/binding";

/** How to launch the harness child for a connection (the deployable-harness bin). */
export interface RelayHarnessSpec {
  /** path to the harness bin — a self-contained deployable-harness bundle */
  bin: string;
  /** args passed to the child (e.g. `--config`, `--output-dir`) */
  args?: string[];
  /** extra env for the child; `RR_BRIDGE=1` is always injected to select bridge mode */
  env?: NodeJS.ProcessEnv;
}

/**
 * The minimal wss socket the relay bridges to — structurally satisfied by the
 * `ws` library's socket. The reference server (src/server.ts) supplies it, so
 * this glue never imports `ws`.
 */
export interface RelaySocket {
  send(data: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  close(): void;
}

export interface BridgeConnectionOpts {
  harness: RelayHarnessSpec;
  /** observe the client-visible lifecycle the relay authors (in addition to the wire) */
  onState?: (state: SessionState) => void;
}

/**
 * Bridge ONE wss connection to a freshly-forked harness child — Option A: one
 * process, one model residency per connection. Frames flow event/ready from the
 * child out to the socket, and command frames from the socket in to the child.
 *
 * The relay is the box gateway here: it **authors `SessionState`** — `warming`
 * on fork, `live` on the child's `ready`, `died` on exit — and posts it on the
 * `session` plane (never produced by the harness). Stateless: no durable log, no
 * reconnect replay — durability is a deferred, separate concern.
 *
 * Returns a disposer that kills the child; also wired to socket close.
 */
export function bridgeConnection(
  socket: RelaySocket,
  opts: BridgeConnectionOpts,
): () => void {
  const { harness, onState } = opts;

  // One fixed Session per connection (MVP); carried on every wss frame so the
  // protocol never bakes in connection ≡ Session.
  const sessionId = randomUUID();
  // Terminal teardown: kill the child (if forked) + close the socket. Idempotent;
  // reached from the socket "close" event, child exit, OR a send failure (the
  // socket died without a clean close, so nothing else would tear the child down).
  let closed = false;
  let child: ChildProcess | undefined;
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    if (child && !child.killed) child.kill();
    socket.close();
  };
  const route = (
    frame: BindingFrame<unknown, unknown> | SessionFrame,
  ): void => {
    if (closed) return;
    const routed: RoutedBindingFrame<unknown, unknown> = { sessionId, frame };
    try {
      socket.send(JSON.stringify(routed));
    } catch {
      dispose(); // socket died mid-flight — tear the child + socket down
    }
  };

  const postState = (state: SessionState): void => {
    onState?.(state);
    route({ t: "session", payload: state }); // the session plane, a SessionFrame
  };

  postState({ phase: "warming" });
  // If the warming post already failed, the socket is dead — don't fork an orphan.
  if (closed) return dispose;

  child = fork(harness.bin, harness.args ?? [], {
    env: { ...process.env, ...harness.env, RR_BRIDGE: "1" },
  });

  // child → socket: the forked harness posts **bare** run-plane BindingFrames over
  // fork IPC. Wrap each in the routed envelope; the child's `ready` flips → live.
  child.on("message", (m: unknown) => {
    const frame = m as BindingFrame<unknown, unknown>;
    if (frame?.t === "ready") postState({ phase: "live" });
    route(frame);
  });

  // socket → child: unwrap the routed frame; only `command` crosses down to the
  // child, which speaks the bare run-plane BindingFrame over fork IPC.
  socket.on("message", (data: unknown) => {
    if (closed) return; // dispose stops inbound too — no late command to a dying child
    let m: RoutedBindingFrame<unknown, unknown>;
    try {
      m = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // ignore non-JSON / binary frames
    }
    // Guard: a late command after the child died/disconnected would throw
    // ERR_IPC_CHANNEL_CLOSED and crash the relay.
    if (m?.frame?.t === "command" && child?.connected) {
      try {
        child.send(m.frame);
      } catch {
        /* child channel closed between the check and the send */
      }
    }
  });

  // terminal: child death → `died` (carry signal/code); then tear down.
  child.on("exit", (code, signal) => {
    postState({
      phase: "died",
      ...(signal ? { signal } : {}),
      ...(code != null ? { code } : {}),
    });
    dispose();
  });

  socket.on("close", dispose);

  return dispose;
}
