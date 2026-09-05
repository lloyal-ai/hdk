import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The trace vocabulary is a contract with every reader of trace.jsonl, so a
 * variant that nothing writes is a promise nobody keeps. This scan holds the
 * declared vocabulary in `trace-types.ts` to the code that emits it: every
 * event `type` literal, and every `reason` literal of the two pool events that
 * carry one, must appear as a string somewhere in an emitting package.
 *
 * Emitting packages are the runtime (`agents`), the rig, and the abilities —
 * `dev-tools` only reads, so it is deliberately NOT scanned: a literal that
 * exists only in a reducer would satisfy a text match while still being dead.
 *
 * Known limit: the match is on the bare string, so a reason shared by two
 * events (e.g. `tool_error` as a result source and as a drop reason) is
 * vouched for by either. That is the same test the audit ran by hand; it
 * catches whole-vocabulary drift, not per-event drift.
 */
const REPO = join(__dirname, '..', '..', '..');
const VOCABULARY = join(REPO, 'packages/agents/src/trace-types.ts');
const ROOTS = [
  'packages/agents/src',
  'packages/rig/src',
  ...readdirSync(join(REPO, 'packages/abilities'))
    .map(name => join('packages/abilities', name, 'src'))
    .filter(dir => { try { return statSync(join(REPO, dir)).isDirectory(); } catch { return false; } }),
];

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) yield p;
  }
}

function emittingSource(): string {
  let all = '';
  for (const root of ROOTS) {
    for (const file of tsFiles(join(REPO, root))) {
      if (file === VOCABULARY) continue;
      all += readFileSync(file, 'utf8');
    }
  }
  return all;
}

/** The `reason:` union that follows a given `type:` literal in the vocabulary file. */
function reasonsOf(vocabulary: string, type: string): string[] {
  const start = vocabulary.indexOf(`type: '${type}'`);
  if (start < 0) return [];
  const block = vocabulary.slice(start, vocabulary.indexOf('}', start));
  const reasonAt = block.indexOf('reason:');
  if (reasonAt < 0) return [];
  const union = block.slice(reasonAt, block.indexOf(';', reasonAt));
  return [...union.matchAll(/'([A-Za-z_]+)'/g)].map(m => m[1]);
}

describe('trace vocabulary is emitted', () => {
  const vocabulary = readFileSync(VOCABULARY, 'utf8');
  const emitted = emittingSource();
  // Either quote style: the runtime writes single-quoted literals, the abilities double.
  const missing = (literals: string[]) =>
    literals.filter(l => !emitted.includes(`'${l}'`) && !emitted.includes(`"${l}"`));

  it('every declared event type has an emit site', () => {
    const types = [...new Set([...vocabulary.matchAll(/type: '([^']+)'/g)].map(m => m[1]))];
    expect(types.length).toBeGreaterThan(30);
    expect(missing(types), 'declared in trace-types.ts, written nowhere').toEqual([]);
  });

  it('every pool:agentDrop reason has an emit site', () => {
    const reasons = reasonsOf(vocabulary, 'pool:agentDrop');
    expect(reasons.length).toBeGreaterThan(5);
    expect(missing(reasons), 'declared drop reasons, written nowhere').toEqual([]);
  });

  it('every pool:agentNudge reason has an emit site', () => {
    const reasons = reasonsOf(vocabulary, 'pool:agentNudge');
    expect(reasons.length).toBeGreaterThan(1);
    expect(missing(reasons), 'declared nudge reasons, written nowhere').toEqual([]);
  });
});
