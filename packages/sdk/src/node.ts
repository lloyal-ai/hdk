/** Native context construction. Keep this entry out of browser module graphs. */
import { createContext as native } from '@lloyal-labs/lloyal.node';
import type { ContextOptions, LoadOptions, SessionContext } from './types';

/** Build a session context on the native runtime, optionally naming the backend to load it on. */
export function createContext(options: ContextOptions, load?: LoadOptions): Promise<SessionContext> {
  return native(options, load);
}
