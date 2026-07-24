/**
 * The desktop target — your harness in a native window (Electron).
 *
 * Electron's MAIN process is a thin host: it owns the window and forks THIS
 * project's OWN cli bin (`bin/run.js`) as the engine, with `RR_BRIDGE=1` set —
 * which makes the cli boot mount the `ipc` binding instead of Ink (see
 * `targets/cli/index.ts`). Heavy work (native inference, the Effection harness)
 * lives in that forked engine process, so the UI thread never blocks.
 *
 * Streaming model (identical to cli/web): the engine emits raw `WorkflowEvent`s;
 * main FORWARDS each one (+ a monotonic `seq`) to the renderer, which folds it
 * through the SAME pure `reduce` — so only the small event crosses IPC, never
 * the growing transcript. Main also mirrors state into `appState` purely to
 * answer ONE snapshot per (re)load: the renderer seeds from it and applies only
 * events with `seq > snapshot.seq` (a consistent cut — no gap, no double-apply).
 */
import { app, BrowserWindow, ipcMain, shell, utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { reduce, initialState, type AppState } from "../../harness/state.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";

/** Only http(s) links may leave the app. */
function isExternalUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

let win: BrowserWindow | null = null;
let engine: UtilityProcess | null = null;
let appState: AppState = initialState;
let seq = 0;

/** Send to the renderer only if the window is still alive (`win?.` is not
 *  enough — on close `win` is non-null but DESTROYED and `.send` throws). */
function safeSend(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function spawnEngine(): void {
  // The engine is THIS project's compiled cli boot (`bin/run.js` →
  // `dist/targets/cli/index.js`), forked with RR_BRIDGE so it streams over
  // parentPort. Build the cli first (`tsc`) — `npm run dev:desktop` does. cwd
  // stays the project root so the forked cli reads `harness.yml` + `models/`.
  const enginePath = join(process.cwd(), "bin", "run.js");
  if (!existsSync(enginePath)) {
    throw new Error(
      `engine not built: ${enginePath} not found — run \`tsc\` (or \`npm run dev:desktop\`) first.`,
    );
  }
  const env = { ...process.env, RR_BRIDGE: "1" };
  engine = utilityProcess.fork(enginePath, [], {
    serviceName: "harness-engine",
    stdio: "pipe",
    env,
  });
  engine.stdout?.on("data", (d) => console.log("[engine]", d.toString().trimEnd()));
  engine.stderr?.on("data", (d) => console.error("[engine]", d.toString().trimEnd()));
  engine.on("message", (msg: { t?: string; payload?: WorkflowEvent }) => {
    if (msg?.t === "event" && msg.payload) {
      seq++;
      appState = reduce(appState, msg.payload);
      safeSend("harness:event", { seq, ev: msg.payload });
    }
  });
  engine.on("exit", (code) => console.log("[engine] exited", code));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 520,
    show: false,
    backgroundColor: "#0b0d12",
    title: "__NAME__",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
  });
  // Links open in the system browser; never navigate the renderer away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  spawnEngine();
  createWindow();
  // renderer → engine (Command)
  ipcMain.on("harness:command", (_e, command: Command) => {
    engine?.postMessage({ t: "command", payload: command });
  });
  // renderer (re)load → consistent cut: reduced state + the seq it reflects.
  ipcMain.handle("harness:snapshot", () => ({ state: appState, seq }));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("quit", () => engine?.kill());
