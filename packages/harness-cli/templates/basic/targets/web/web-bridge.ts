/**
 * The browser side of the web target — installs a `window.harness` bridge backed
 * by `connectWss`, the SAME shape the desktop preload exposes over IPC. That's
 * why the shared React view (`../_shared/App.tsx`) is transport-agnostic: it only
 * reads `window.harness`, whether that's IPC (desktop) or wss (web).
 */
import { connectWss, type WssClient } from "@lloyal-labs/binding/web";
import { initialState, type AppState } from "../../harness/state.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";

/** Where the served host lives: build-time `VITE_WSS_URL`, a `?server=` query
 *  param, then the local `npm run serve` default. */
function resolveWssUrl(): string {
  const env = (import.meta as unknown as { env?: { VITE_WSS_URL?: string } }).env?.VITE_WSS_URL;
  if (env) return env;
  const q = new URLSearchParams(window.location.search).get("server");
  if (q) return q;
  return "ws://127.0.0.1:8787";
}

export function installWebBridge(): void {
  let client: WssClient<Command> | null = null;
  let seq = 0;
  let active = false; // at least one subscriber wants the stream
  let retry: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(f: { seq: number; ev: WorkflowEvent }) => void>();

  const clearRetry = (): void => {
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
  };

  // (Re)connect to the host. The browser is a CLIENT — the resident-model host
  // is `npm run serve`. If it isn't up yet (a fresh `npm run dev:web` boots both
  // and Vite wins the race, or you start `serve` in another shell after) the
  // socket closes; retry until it answers, so the view isn't stuck forever.
  const connect = (): void => {
    client = connectWss<WorkflowEvent, Command>(resolveWssUrl(), {
      onEvent: (ev) => {
        const frame = { seq: ++seq, ev }; // synthesize a monotonic seq the wire doesn't carry
        for (const l of listeners) l(frame);
      },
      onClose: () => {
        client = null;
        if (active) {
          clearRetry();
          retry = setTimeout(connect, 1000);
        }
      },
    });
  };

  const api = {
    onEvent(cb: (f: { seq: number; ev: WorkflowEvent }) => void): () => void {
      listeners.add(cb);
      // Lazy-connect on first subscription (the view subscribes in its effect).
      if (!active) {
        active = true;
        connect();
      }
      return () => {
        listeners.delete(cb);
        // Last listener gone (view unmount / HMR): stop retrying, close the
        // socket so it isn't leaked, and reset — a later subscription reconnects
        // a fresh session (which re-seeds from initialState @ 0, matching
        // requestSnapshot).
        if (listeners.size === 0) {
          active = false;
          clearRetry();
          client?.close();
          client = null;
          seq = 0;
        }
      };
    },
    send(command: Command): void {
      client?.send(command);
    },
    // The wss stream carries no snapshot — start from initialState at seq 0.
    requestSnapshot(): Promise<{ state: AppState; seq: number }> {
      return Promise.resolve({ state: initialState, seq: 0 });
    },
  };

  (window as unknown as { harness: typeof api }).harness = api;
}
