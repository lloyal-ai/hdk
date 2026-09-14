/**
 * The preload bridge: `window.harness` for the renderer over Electron's
 * contextBridge, the same {@link Bridge} shape the web target backs with
 * `createBridge`, so the view is transport-agnostic. Frames come down on
 * `harness:event`, commands go up on `harness:command`, the snapshot is one
 * `harness:snapshot` round trip, and the content plane is the custom scheme.
 *
 * Import from `@lloyal-labs/desktop/preload` in the preload script only.
 *
 * @category Desktop
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Frame, Snapshot } from '@lloyal-labs/binding';
import { CHANNELS } from './preload-channels';

export { CHANNELS };

export function preloadBridge<E, C, S>(contentOrigin = 'attachment://store'): void {
  const api: Bridge<E, C, S> = {
    onEvent(cb: (frame: Frame<E>) => void): () => void {
      const h = (_e: unknown, frame: Frame<E>): void => cb(frame);
      ipcRenderer.on(CHANNELS.event, h);
      return () => {
        ipcRenderer.removeListener(CHANNELS.event, h);
      };
    },
    send(command: C): void {
      ipcRenderer.send(CHANNELS.command, command);
    },
    requestSnapshot(): Promise<Snapshot<S>> {
      return ipcRenderer.invoke(CHANNELS.snapshot) as Promise<Snapshot<S>>;
    },
    contentOrigin(): string {
      return contentOrigin;
    },
  };
  contextBridge.exposeInMainWorld('harness', api);
}
