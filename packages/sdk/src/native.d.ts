/**
 * The native module's construction contract. The SDK owns the context types and the addon implements
 * them, so the SDK's build reads this declaration instead of the addon's own, which would make the SDK's
 * types depend on whatever the installed addon re-exports.
 */
import type { ContextOptions, LoadOptions, SessionContext } from './types';

export function createContext(options: ContextOptions, load?: LoadOptions): Promise<SessionContext>;
