/**
 * The preload bridge — exposes a tiny `window.harness` to the renderer over
 * Electron's contextBridge (contextIsolation-safe). The renderer talks ONLY to
 * this surface, which is the SAME shape the web target backs with `connectWss`
 * — so the React view is transport-agnostic and both surfaces reuse it.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { AppState } from "../../harness/state.js";
import type { WorkflowEvent, Command } from "../../harness/protocol.js";

const api = {
  /** Subscribe to `{ seq, ev }` frames the main process forwards. */
  onEvent(cb: (frame: { seq: number; ev: WorkflowEvent }) => void): () => void {
    const h = (_e: unknown, frame: { seq: number; ev: WorkflowEvent }): void => cb(frame);
    ipcRenderer.on("harness:event", h);
    return () => {
      ipcRenderer.removeListener("harness:event", h);
    };
  },
  /** Send a Command up to the engine. */
  send(command: Command): void {
    ipcRenderer.send("harness:command", command);
  },
  /** One consistent-cut snapshot per (re)load: reduced state + the seq it reflects. */
  requestSnapshot(): Promise<{ state: AppState; seq: number }> {
    return ipcRenderer.invoke("harness:snapshot");
  },
};

contextBridge.exposeInMainWorld("harness", api);
