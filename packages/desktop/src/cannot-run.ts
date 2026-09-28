/**
 * What a shell does when the harness cannot start at all.
 *
 * A boot failure in an installed application has nowhere to go. The renderer is not up, so there is
 * no view to put a message in; stderr goes to a log nobody opens, because an app launched from the
 * Finder has no terminal attached. Left alone, the window never appears and the reader is told
 * nothing — the same silence as a crash, for what is usually a sentence they could act on: a
 * read-only folder, a manifest that does not parse, a broken installation.
 *
 * So the last thing on the way out says it, in the one way that works before a window exists, and
 * then stops. There is no second thing to try: every failure this catches happened before the engine
 * was forked, so nothing is half-running and nothing is half-written.
 *
 * @category Desktop
 */
import { app, dialog } from 'electron';

/**
 * Show why this harness cannot run, and quit.
 *
 * Wired as the boot's last resort — `app.whenReady().then(…).catch(cannotRun)` — so one line covers
 * every failure on the way up rather than each caller guarding its own. The exit code is for whoever
 * launched it from a script; the dialog is for the person who double-clicked.
 */
export function cannotRun(err: unknown): void {
  const why = err instanceof Error ? err.message : String(err);
  // stderr first: a developer running this from a terminal wants the stack, and a dialog has no room
  // for one. `console.error` rather than the log seam, which belongs to the engine's output.
  console.error(err);
  // Before `ready` there is no window to own this, and `showErrorBox` needs none.
  dialog.showErrorBox(`${app.getName()} cannot start`, why);
  app.exit(1);
}
