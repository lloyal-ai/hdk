/**
 * Shared guard for the in-project commands (`models:` + `targets:`): they mutate
 * the CURRENT harness project, so they must be run from its root.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The cwd, verified to be a harness project (a `harness.yml` sits here). Throws
 * a friendly error otherwise — the caller prints it and exits non-zero.
 */
export function harnessProjectRoot(): string {
  const cwd = process.cwd();
  if (!existsSync(join(cwd, 'harness.yml'))) {
    throw new Error(
      'not a harness project — no harness.yml in the current directory. Run this ' +
        'from your harness project root (where `harness.dev new` scaffolded it).',
    );
  }
  return cwd;
}
