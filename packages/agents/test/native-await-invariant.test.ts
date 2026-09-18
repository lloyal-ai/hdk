import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A native decode queued on the libuv thread pool cannot be recalled: Effection
 * halt drops the JS promise while the batch keeps writing the context. Every
 * operation that issues one must exit only once it has settled — that is
 * `waitUntilSettled`. A bare `call(() => …prefill())` or `until(…commit())`
 * reintroduces the teardown race this rule exists to close, so the rule is
 * checked mechanically here rather than remembered.
 */
const REPO = join(__dirname, '..', '..', '..');
const ROOTS = ['packages/agents/src', 'packages/rig/src'];
const DECODES = 'prefill|prefillMultimodal|prefillUser|prefillUserMultimodal|prefillAssistant|commit|commitTurn|retainOnly|promote';
const BARE = new RegExp(String.raw`\b(?:call|until)\(\s*(?:\(\)\s*=>\s*)?(?:[\w.]+\.(?:${DECODES})|deltaCells)\(`, 'g');

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) yield p;
  }
}

describe('native decodes are awaited with waitUntilSettled', () => {
  it('no Effection package wraps a store decode in a bare call() or until()', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of tsFiles(join(REPO, root))) {
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(BARE)) {
          const line = src.slice(0, m.index).split('\n').length;
          hits.push(`${relative(REPO, file)}:${line}  ${m[0].replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(hits, `bare native awaits:\n  ${hits.join('\n  ')}`).toEqual([]);
  });
});
