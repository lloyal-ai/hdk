/**
 * The scanner behind `package-surface.test.ts`: which names a source file
 * takes from a package specifier. Kept separate so the scan itself can be
 * tested against fixtures.
 */

/** Names an `export { … } from` block exports, aliases resolved to the exported name. */
export function exportedNames(indexSource: string): Set<string> {
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

/** Names a source file takes from `specifier` (the package-side name, before any alias). */
export function namesTakenFrom(source: string, specifier: string): string[] {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // `import { … } from` and `export { … } from` take names the same way.
  const pattern = new RegExp(String.raw`(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]${escaped}['"]`, 'g');
  const out: string[] = [];
  for (const m of source.matchAll(pattern)) {
    for (const raw of m[1].split(',')) {
      const entry = raw.trim();
      if (!entry) continue;
      out.push(entry.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim());
    }
  }
  return out;
}
