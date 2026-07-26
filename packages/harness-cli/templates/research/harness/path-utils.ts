/**
 * Resolve a user-typed path to an absolute path.
 *
 * Three input forms a user might enter (composer field, CLI flag, or
 * harness.json) handled here:
 *   - "~" or "~/foo"             → expanded against os.homedir()
 *   - "/absolute/path"           → unchanged
 *   - "./relative" or "relative" → resolved against process.cwd()
 *
 * Empty input returns ''. Idempotent — calling on an already-absolute
 * path leaves it absolute. This mirrors what bash/zsh do before passing
 * args to a program; Node's `path` module deliberately doesn't replicate
 * shell ergonomics, so the application layer handles it at the boundary.
 *
 * Apply at the boundary between user input and persisted/live state:
 *   - composer commit handlers (set_output_dir, set_app_config path values)
 *   - loadConfig (defensive — handles stale `~`-bearing harness.json)
 *
 * Persisted form should always be absolute; downstream consumers can
 * treat paths as opaque strings without re-expansion.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export function resolvePath(input: string): string {
  if (!input) return '';
  const expanded =
    input === '~'
      ? os.homedir()
      : input.startsWith('~/')
        ? path.join(os.homedir(), input.slice(2))
        : input;
  return path.resolve(expanded);
}
