/**
 * The microphone, for the app's own windows and nothing else. Chromium asks the
 * session, the session asks the operating system, and a refusal reaches the
 * renderer as a refusal rather than a silent hang. Camera, screen and every
 * other permission stay denied: a harness that needs one adds it deliberately.
 *
 * @category Desktop
 */
import { BrowserWindow, dialog, shell, systemPreferences } from 'electron';
import type { Session, WebContents } from 'electron';

/** The boot's `LLOYAL_DEV` signal, as `config:loaded.dev` carries it: the same gate dev-tools loads behind. */
let dev = false;

/** Where macOS keeps the answer once it has been given; the one place a "no" can become a "yes". */
const MICROPHONE_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

/** The operating system's answer. Undecided: it prompts, exactly as a browser would. Decided against:
 *  macOS never prompts again, so the person is told where the decision lives and offered the way there,
 *  rather than left with a dead button or thrown into System Settings unannounced. */
export async function microphoneConsent(contents: WebContents | null): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') {
    await explainRefusal(contents);
    return false;
  }
  return systemPreferences.askForMediaAccess('microphone');
}

/** How the common terminals name themselves in the environment they hand their children. */
const TERMINALS: Record<string, string> = {
  Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', vscode: 'Visual Studio Code', WarpTerminal: 'Warp',
  Hyper: 'Hyper', WezTerm: 'WezTerm', Alacritty: 'Alacritty', ghostty: 'Ghostty', kitty: 'kitty',
};

/** A process started from a terminal is the terminal in the eyes of macOS; it has no entry of its own.
 *  Allowing the terminal makes macOS relaunch it, which takes this app down with it, so the note says
 *  what to run afterwards: the npm script that started us, when npm tells us its name. */
function developmentNote(): string {
  const terminal = TERMINALS[process.env.TERM_PROGRAM ?? ''] ?? 'the terminal it was started from';
  const script = process.env.npm_lifecycle_event;
  const again = script ? `npm run ${script}` : 'the dev command';
  return `Started from a terminal, this app is listed there as ${terminal}. Allow ${terminal}, let macOS quit and reopen it, which stops this app, then run ${again} again.`;
}

async function explainRefusal(contents: WebContents | null): Promise<void> {
  const owner = contents ? BrowserWindow.fromWebContents(contents) : null;
  const options = {
    type: 'warning' as const,
    message: 'Microphone access is off for this app',
    detail: [
      'Allow it in System Settings, under Privacy & Security, then Microphone, and try again.',
      ...(dev ? [developmentNote()] : []),
    ].join('\n\n'),
    buttons: ['Open System Settings', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (response === 0) void shell.openExternal(MICROPHONE_SETTINGS);
}

/** The first frame on the wire: the resolved config, and whether this is a dev boot. */
function loadedConfig(ev: unknown): { dev: boolean; dictates: boolean } | null {
  if (typeof ev !== 'object' || ev === null) return null;
  const { type, config, dev } = ev as { type?: unknown; config?: { model?: { transcription?: unknown } }; dev?: unknown };
  if (type !== 'config:loaded') return null;
  return { dev: dev === true, dictates: config?.model?.transcription !== undefined };
}

let askedAtLaunch = false;

/** In a dev boot, ask for the microphone as soon as the engine says the harness dictates, before the
 *  models load: an undecided system prompts at once, and a recorded refusal is explained while a relaunch
 *  is still cheap. A shipped app does nothing here; its first press prompts with the usage string, in
 *  context. Feed every forwarded frame's event; it acts once per process and only on the config frame. */
export function prepareMicrophone(ev: unknown, contents: () => WebContents | null): void {
  const loaded = loadedConfig(ev);
  if (!loaded) return;
  dev = loaded.dev;
  if (!dev || askedAtLaunch || !loaded.dictates) return;
  askedAtLaunch = true;
  void microphoneConsent(contents()).catch(() => undefined);
}

/** Grant audio capture to the windows `owns` vouches for, after consent, and deny every other request. */
export function allowMicrophone(
  ses: Session,
  owns: (contents: WebContents | null) => boolean,
  consent: (contents: WebContents | null) => Promise<boolean> = microphoneConsent,
): void {
  // The check is consulted on its own, so it draws the same line the request does: audio, for an owned window.
  ses.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && owns(contents));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const wantsVideo = 'mediaTypes' in details && (details.mediaTypes ?? []).includes('video');
    if (permission !== 'media' || wantsVideo || !owns(contents)) { callback(false); return; }
    consent(contents).then(callback, () => callback(false));
  });
}
