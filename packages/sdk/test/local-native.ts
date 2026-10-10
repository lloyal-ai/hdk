import { strict as assert } from 'node:assert';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext } from '@lloyal-labs/sdk/node';
import type { ContextOptions, SessionContext } from '@lloyal-labs/sdk';

export const nativeRepo = resolve(process.env.LLOYAL_NODE_REPO ?? resolve(__dirname, '../../../../lloyal-node'));

export function verifyLocalNative(opts: { loaded?: boolean } = {}): void {
  assert.equal(process.env.LLOYAL_LOCAL, '1', 'exercise the local native build');
  const entry = realpathSync(require.resolve('@lloyal-labs/lloyal.node'));
  assert.equal(entry, realpathSync(resolve(nativeRepo, 'dist/index.js')), 'SDK resolves the intended native checkout');
  console.log(`Native entry: ${entry}`);
  if (!opts.loaded) return;
  const binary = realpathSync(resolve(nativeRepo, 'build/Release/lloyal.node'));
  assert.ok(require.cache[binary], 'context creation loaded the intended addon');
  console.log(`Native addon: ${binary}`);
}

export async function createLocalContext(options: ContextOptions): Promise<SessionContext> {
  verifyLocalNative();
  const ctx = await createContext(options);
  verifyLocalNative({ loaded: true });
  return ctx;
}
