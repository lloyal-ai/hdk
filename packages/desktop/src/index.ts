/**
 * `@lloyal-labs/desktop` — a harness in a native window. The Electron main
 * process is a thin host: it owns the window and forks the project's own cli
 * bin as the engine; heavy work (native inference, the harness) lives there,
 * so the UI thread never blocks.
 *
 * @packageDocumentation
 * @category Desktop
 */
export { createEngine } from './engine';
export type { Engine, EngineProcess, CreateEngineOpts } from './engine';
export { registerContentScheme, serveContentScheme, CONTENT_ORIGIN } from './content';
export { readBounded, TooLarge, TooSlow } from './read-bounded';
export { createWindow } from './window';
export type { CreateWindowOpts } from './window';
export { CHANNELS } from './preload-channels';
