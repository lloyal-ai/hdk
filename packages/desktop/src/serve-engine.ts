/**
 * Main's side of the bridge, wired in one call: every channel the preload speaks, answered by the engine —
 * commands in, the snapshot, the session and what is being acquired, a working engine on request, and the
 * system dialog for a file the reader already has. A template's main forks the engine, opens the window and
 * calls this; it never lists the channels.
 *
 * @category Desktop
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { Engine } from './engine';
import { CHANNELS } from './preload-channels';

/** One file, opened for reading. `extensions` comes from the caller because what counts as a model is the
 *  engine's business, not this shell's. */
function dialogOptions(opts?: { extensions?: readonly string[]; title?: string }) {
  return {
    title: opts?.title ?? 'Choose a file',
    properties: ['openFile' as const],
    ...(opts?.extensions?.length ? { filters: [{ name: 'Models', extensions: [...opts.extensions] }] } : {}),
  };
}

/**
 * Answer the preload's channels from this engine. `send` delivers a frame to whichever renderer is alive —
 * the caller's `webContents.send`, guarded against a destroyed window. Returns the unsubscribe.
 */
export function serveEngine<C, S>(engine: Engine<C, S>, send: (channel: string, payload: unknown) => void): () => void {
  const offSession = engine.onSession((state) => send(CHANNELS.session, state));
  const onCommand = (_e: unknown, command: C): void => { engine.send(command); };
  ipcMain.on(CHANNELS.command, onCommand);
  ipcMain.handle(CHANNELS.snapshot, () => engine.snapshot());
  ipcMain.handle(CHANNELS.sessionNow, () => engine.session());
  // A reader asking for a working harness. Here that is a new engine process — the renderer's own IPC link
  // never dropped, which is why this is not a reload.
  ipcMain.handle(CHANNELS.recover, () => engine.restart());
  ipcMain.handle(CHANNELS.installNow, () => engine.install());
  ipcMain.handle(CHANNELS.bootstrap, () => engine.bootstrap());
  ipcMain.handle(CHANNELS.chooseFile, async (_e, opts?: { extensions?: readonly string[]; title?: string }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const picked = await (win ? dialog.showOpenDialog(win, dialogOptions(opts)) : dialog.showOpenDialog(dialogOptions(opts)));
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });
  return () => {
    offSession();
    ipcMain.off(CHANNELS.command, onCommand);
    for (const channel of [CHANNELS.snapshot, CHANNELS.sessionNow, CHANNELS.recover, CHANNELS.installNow, CHANNELS.bootstrap, CHANNELS.chooseFile]) ipcMain.removeHandler(channel);
  };
}
