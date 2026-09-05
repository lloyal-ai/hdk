/**
 * The package's public surface is what `src/index.ts` exports, and every file
 * in this repository that imports `@lloyal-labs/lloyal-agents` must name only
 * that. A removed export that a sibling package, ability, example or script
 * still imports is a break nothing else catches: the root typecheck covers
 * package sources and the test suites, not every tracked file.
 *
 * String scan, same shape as `trace-vocabulary.test.ts`: the export list is
 * read off the index's `export { … } from` blocks (the index has no star
 * exports), the importers off `git ls-files`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportedNames, namesTakenFrom } from './helpers/package-surface';

const REPO = join(__dirname, '..', '..', '..');
const SPECIFIER = '@lloyal-labs/lloyal-agents';

/** `[file, name]` for every name taken from the package across the repo. */
function importedNames(): [string, string][] {
  // Tracked AND present: a file deleted in the working tree is no importer,
  // whether or not the deletion is staged yet.
  const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(f => f && existsSync(join(REPO, f)));
  const out: [string, string][] = [];
  for (const file of files) {
    for (const name of namesTakenFrom(readFileSync(join(REPO, file), 'utf8'), SPECIFIER)) out.push([file, name]);
  }
  return out;
}

describe('package surface', () => {
  it('every import of @lloyal-labs/lloyal-agents in the repo names an export of src/index.ts', () => {
    const exports = exportedNames(readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8'));
    expect(exports.size).toBeGreaterThan(20);
    const dangling = importedNames().filter(([, name]) => !exports.has(name));
    expect(dangling, dangling.map(([f, n]) => `${f} imports ${n}`).join('\n')).toEqual([]);
  });

  it('the scan reads re-exports too — `export { … } from` takes names the same way `import` does', () => {
    const fixture = [
      `import { Agent, type Tool as T } from '@lloyal-labs/lloyal-agents';`,
      `export type { AgentPolicy, ProduceAction as Action } from '@lloyal-labs/lloyal-agents';`,
      `export { parallel } from '@lloyal-labs/lloyal-agents';`,
      `import { unrelated } from '@lloyal-labs/sdk';`,
    ].join('\n');
    expect(namesTakenFrom(fixture, SPECIFIER).sort()).toEqual(['Agent', 'AgentPolicy', 'ProduceAction', 'Tool', 'parallel']);
  });
});
