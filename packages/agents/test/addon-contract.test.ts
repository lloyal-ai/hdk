/**
 * The agents package names the addon contract it needs at pool open, not at
 * the first field it dereferences inside a spawn: an older lloyal.node, which
 * reports no batch size and hands back a parser definition and a single
 * thinking close, is refused with a message that says which addon is required.
 */
import { describe, it, expect } from 'vitest';
import { runPool, STOP } from './invariants/harness';

describe('the addon contract', () => {
  it('an older format result is refused by name', async () => {
    const run = runPool({
      nCtx: 8192, cellsUsed: 0, scripts: [{ tokens: [1, STOP] }], maxTurns: 2, taskCount: 1,
      instrument: (ctx) => { (ctx as unknown as { nBatch: number | undefined }).nBatch = undefined; },
    });
    await expect(run).rejects.toThrow(/lloyal\.node 4 or later is required/);
  });
});
