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

const REPO = join(__dirname, '..', '..', '..');
const SPECIFIER = '@lloyal-labs/lloyal-agents';

/** Names an `export { … } from` block exports, aliases resolved to the exported name. */
function exportedNames(indexSource: string): Set<string> {
  const names = new Set<string>();
  for (const m of indexSource.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const entry = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!entry) continue;
      const withoutType = entry.replace(/^type\s+/, '');
      const alias = withoutType.split(/\s+as\s+/);
      names.add(alias[alias.length - 1].trim());
    }
  }
  return names;
}

/** `[file, name]` for every name imported from the package across the repo. */
function importedNames(): [string, string][] {
  // Tracked AND present: a file deleted in the working tree is no importer,
  // whether or not the deletion is staged yet.
  const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(f => f && existsSync(join(REPO, f)));
  const out: [string, string][] = [];
  const pattern = new RegExp(String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]${SPECIFIER}['"]`, 'g');
  for (const file of files) {
    const src = readFileSync(join(REPO, file), 'utf8');
    for (const m of src.matchAll(pattern)) {
      for (const raw of m[1].split(',')) {
        const entry = raw.trim();
        if (!entry) continue;
        const imported = entry.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        out.push([file, imported]);
      }
    }
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
});
