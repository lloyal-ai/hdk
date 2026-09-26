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
import type { Bridge, Frame, SessionState, Snapshot } from '@lloyal-labs/binding';
import { CHANNELS } from './preload-channels';
import { subscribeSeeded } from './seeded-subscription';

export { CHANNELS };

export function preloadBridge<E, C, S>(contentOrigin = 'attachment://store'): void {
  const api: Bridge<E, C, S> = {
    onEvent(cb: (frame: Frame<E>) => void): () => void {
      // Told what it missed first: the frames main retained, then the live stream in order. A view that
      // mounts once the installer has cleared has missed the harness's opening frames otherwise.
      return subscribeSeeded<Frame<E>>({
        live: (deliver) => {
          const h = (_e: unknown, frame: Frame<E>): void => deliver(frame);
          ipcRenderer.on(CHANNELS.event, h);
          return () => { ipcRenderer.removeListener(CHANNELS.event, h); };
        },
        seed: () => ipcRenderer.invoke(CHANNELS.bootstrap) as Promise<Frame<E>[]>,
      }, cb);
    },
    send(command: C): void {
      ipcRenderer.send(CHANNELS.command, command);
    },
    requestSnapshot(): Promise<Snapshot<S>> {
      return ipcRenderer.invoke(CHANNELS.snapshot) as Promise<Snapshot<S>>;
    },
    onSession(cb: (state: SessionState) => void): () => void {
      // A renderer that has just loaded needs where things stand, not only what changes next: a
      // session can sit at `live` for hours. The push wins a race with the answer, because the
      // answer was true when it was asked and the push is true now.
      let heard = false;
      const h = (_e: unknown, state: SessionState): void => { heard = true; cb(state); };
      ipcRenderer.on(CHANNELS.session, h);
      void (ipcRenderer.invoke(CHANNELS.sessionNow) as Promise<SessionState>).then((now) => {
        if (heard) return;
        heard = true;
        cb(now);
      });
      return () => {
        ipcRenderer.removeListener(CHANNELS.session, h);
      };
    },
    recover(): void {
      // What a working session costs is the placement's business: here, a new engine process.
      void ipcRenderer.invoke(CHANNELS.recover);
    },
    installNow(): Promise<unknown> {
      return ipcRenderer.invoke(CHANNELS.installNow) as Promise<unknown>;
    },
    chooseFile(opts?: { extensions?: readonly string[]; title?: string }): Promise<string | null> {
      // The dialog is main's: a renderer has no filesystem, and this answers a PATH, which is the one thing
      // a browser could never hand back.
      return ipcRenderer.invoke(CHANNELS.chooseFile, opts) as Promise<string | null>;
    },
    contentOrigin(): string {
      return contentOrigin;
    },
  };
  contextBridge.exposeInMainWorld('harness', api);
}
