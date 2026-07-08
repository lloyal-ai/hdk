/**
 * @lloyal-labs/binding/node — the Node transports of the binding.
 *
 * `selectMode` — the `RR_BRIDGE` / TTY / jsonl mode selector.
 * `bindHeadless` — wires a *headless* transport (one-way `jsonl`, or the
 *   `parentPort`-else-`fork` `bridge`) to a harness's `EventBus` + a command
 *   dispatch callback. The `bridge` transport auto-detects Electron `parentPort`
 *   (a local cut) vs a Node forked child's IPC channel (`process.send`). Ink
 *   (in-process) is NOT handled here — the app mounts it directly.
 */

import type { EventBus, BindingFrame } from "./index";

export type BindMode = "ink" | "jsonl" | "bridge";

/**
 * Pick the binding mode. `RR_BRIDGE` forces the bridge transport (some IPC host
 * is present); a TTY without jsonl mounts Ink (app-side); otherwise one-way JSONL.
 */
export function selectMode(opts: {
  env?: NodeJS.ProcessEnv;
  isTTY: boolean;
  jsonl?: boolean;
}): BindMode {
  const bridge = !!(opts.env ?? process.env).RR_BRIDGE;
  if (bridge) return "bridge";
  if (opts.isTTY && !opts.jsonl) return "ink";
  return "jsonl";
}

export interface BindHeadlessOpts<E, C> {
  /** the harness's event bus (events flow out of it) */
  uiChannel: EventBus<E>;
  /** called with each inbound command (the app wraps `commands.send`) */
  dispatch: (command: C) => void;
  /** events seeded before `ready` (e.g. config loaded, download plan) */
  bootstrap: E[];
  /** which headless transport ('ink' is app-side, not accepted here) */
  mode: "jsonl" | "bridge";
  /** jsonl line sink; defaults to stdout NDJSON */
  out?: (line: string) => void;
}

/**
 * Wire a headless transport of the binding. Synchronous setup — the harness's own
 * loop keeps running afterward. The `bridge` transport speaks the `BindingFrame`
 * over Electron `parentPort` if present, else the Node fork IPC channel.
 */
export function bindHeadless<E, C>(opts: BindHeadlessOpts<E, C>): void {
  const { uiChannel, dispatch, bootstrap, mode } = opts;

  if (mode === "jsonl") {
    const out =
      opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
    uiChannel.subscribe((ev) => out(JSON.stringify(ev)));
    for (const ev of bootstrap) uiChannel.send(ev);
    return;
  }

  // mode === "bridge": parentPort (Electron utilityProcess) else fork() IPC.
  const pp = (
    process as unknown as {
      parentPort?: {
        postMessage(m: unknown): void;
        on(e: "message", cb: (ev: { data: unknown }) => void): void;
        start?(): void;
      };
    }
  ).parentPort;

  // `bridge` needs a real IPC channel: Electron `parentPort`, else a
  // `child_process.fork()` child's `process.send`. In a plain Node process
  // (e.g. RR_BRIDGE set outside a fork/Electron parent) neither exists — fail
  // fast with a clear message rather than a cryptic "process.send is not a
  // function" when the first frame posts.
  if (!pp && typeof process.send !== "function") {
    throw new Error(
      "bindHeadless: 'bridge' mode requires an IPC channel — an Electron " +
        "parentPort or a child_process.fork() child (neither process.parentPort " +
        "nor process.send is available).",
    );
  }

  const post: (m: BindingFrame<E, C>) => void = pp
    ? (m) => pp.postMessage(m)
    : (m) => process.send!(m);

  const onMsg = (m: { t?: string; payload?: unknown }): void => {
    if (m?.t === "command") dispatch(m.payload as C);
  };

  if (pp) {
    // Electron MessagePortMain: the envelope arrives wrapped as `e.data`.
    pp.on("message", (e) => onMsg(e.data as { t?: string; payload?: unknown }));
    pp.start?.();
  } else {
    // Node child_process.fork IPC: the envelope arrives directly.
    process.on("message", (m) => onMsg(m as { t?: string; payload?: unknown }));
  }

  uiChannel.subscribe((ev) => post({ t: "event", payload: ev }));

  // No Ink/stdin handle holds the libuv loop open in bridge mode; keep it alive
  // while the suspended command loop waits. Cleared on exit.
  const keepAlive = setInterval(() => {}, 1 << 30);
  process.on("exit", () => clearInterval(keepAlive));

  // Seed bootstrap through the (already-subscribed) bus, then signal ready.
  for (const ev of bootstrap) uiChannel.send(ev);
  post({ t: "ready" });
}
