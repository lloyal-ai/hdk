/**
 * The window: one `BrowserWindow` over the preload bridge, links kept out of
 * the renderer. The renderer loads the dev server's URL when electron-vite
 * provides one, else the built page.
 *
 * @category Desktop
 */
import { BrowserWindow, shell } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';

/** Only http(s) links may leave the app. */
function isExternalUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export interface CreateWindowOpts {
  /** The preload bundle. electron-vite names it after its entry and emits `.mjs`. */
  preload: string;
  /** The built page, loaded when no dev server URL is set (`ELECTRON_RENDERER_URL`). */
  page: string;
  title: string;
  /** Window options over the defaults (size, colours). */
  window?: Partial<BrowserWindowConstructorOptions>;
}

export function createWindow(opts: CreateWindowOpts): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 800, minHeight: 520, show: false, title: opts.title,
    ...opts.window,
    webPreferences: { preload: opts.preload, contextIsolation: true, sandbox: false, ...(opts.window?.webPreferences ?? {}) },
  });
  win.once('ready-to-show', () => win.show());
  // Links open in the system browser; the renderer never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (isExternalUrl(url)) void shell.openExternal(url);
    }
  });
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev) void win.loadURL(dev);
  else void win.loadFile(opts.page);
  return win;
}
