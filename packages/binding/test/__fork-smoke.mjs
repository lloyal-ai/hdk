// Fork-IPC round-trip smoke for the `bridge` transport (Node fork branch).
// GPU-free: a stub "harness" over the fork IPC channel, no model.
// Run AFTER `tsc -b`:  node packages/binding/test/__fork-smoke.mjs
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import core from "../dist/index.js";
import node from "../dist/node.js";

const { createBus } = core;
const { bindHeadless } = node;
const __filename = fileURLToPath(import.meta.url);

if (process.env.__BIND_CHILD) {
  // CHILD: a headless "harness" bound over the fork transport. `parentPort` is
  // undefined here, so bindHeadless uses process.send / process.on('message').
  const bus = createBus();
  bindHeadless({
    uiChannel: bus,
    dispatch: (c) => process.send?.({ t: "cmd-echo", payload: c }),
    bootstrap: [{ type: "boot" }],
    mode: "bridge",
  });
  bus.send({ type: "hello" });
} else {
  // PARENT: fork the child and assert the frame round-trips both ways.
  const child = fork(__filename, [], {
    env: { ...process.env, __BIND_CHILD: "1" },
  });
  const seen = { ready: false, event: false, cmdEcho: false };
  const finish = (ok) => {
    child.kill();
    if (ok) {
      console.log("OK — fork round-trip: ready + event(down) + command(up) echo");
      process.exit(0);
    }
    console.error("FAIL — fork round-trip incomplete:", seen);
    process.exit(1);
  };
  child.on("message", (m) => {
    if (m?.t === "ready") {
      seen.ready = true;
      child.send({ t: "command", payload: { type: "ping" } });
    }
    if (m?.t === "event") seen.event = true;
    if (m?.t === "cmd-echo") seen.cmdEcho = true;
    if (seen.ready && seen.event && seen.cmdEcho) finish(true);
  });
  child.on("error", () => finish(false));
  setTimeout(() => finish(false), 5000);
}
