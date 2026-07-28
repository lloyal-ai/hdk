/**
 * Line-wise editing of a multi-line JSONC string array (`"key": [ ... ]`, one
 * quoted entry per line) that PRESERVES surrounding comments — which a
 * parse→stringify round-trip would drop. Used to add/remove per-target entries
 * in the scaffolded tsconfigs. A single-line array (`"key": ["a", "b"]`) is left
 * untouched by both — templates author the editable arrays one-entry-per-line.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Locate a `"key": [` … `]` block authored one-entry-per-line. */
function locateArray(
  lines: readonly string[],
  key: string,
): { startIdx: number; endIdx: number } | null {
  const openRe = new RegExp(`"${key}"\\s*:\\s*\\[\\s*$`);
  const startIdx = lines.findIndex((l) => openRe.test(l));
  if (startIdx === -1) return null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*\]/.test(lines[i])) return { startIdx, endIdx: i };
  }
  return null;
}

/** Read the quoted entries of a `"key"` array (empty if absent/single-line). */
export function readJsoncArray(filePath: string, key: string): string[] {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const at = locateArray(lines, key);
  if (!at) return [];
  const out: string[] = [];
  for (let i = at.startIdx + 1; i < at.endIdx; i++) {
    const m = lines[i].match(/"([^"]+)"/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Keep only entries for which `keep(entry)` is true, fixing trailing commas so
 * the result stays valid JSON. Comments outside the array are untouched.
 */
export function filterJsoncArray(filePath: string, key: string, keep: (entry: string) => boolean): void {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const at = locateArray(lines, key);
  if (!at) return;

  const kept: string[] = [];
  for (let i = at.startIdx + 1; i < at.endIdx; i++) {
    const m = lines[i].match(/"([^"]+)"/);
    if (m && !keep(m[1])) continue;
    kept.push(lines[i].replace(/,\s*$/, '')); // strip any trailing comma; re-added below
  }
  const rebuilt = kept.map((l, idx) => (idx === kept.length - 1 ? l : `${l},`));
  const out = [...lines.slice(0, at.startIdx + 1), ...rebuilt, ...lines.slice(at.endIdx)];
  writeFileSync(filePath, out.join('\n'));
}

/**
 * Add `newEntries` (deduped against what's already there) into the `"key"`
 * array, re-emitting every entry with correct commas. The inverse of
 * {@link filterJsoncArray}. Indentation matches the array's existing entries.
 */
export function mergeJsoncArray(filePath: string, key: string, newEntries: readonly string[]): void {
  if (newEntries.length === 0) return;
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const at = locateArray(lines, key);
  if (!at) return;

  const body: string[] = []; // bare quoted entries, comma-stripped
  const existing = new Set<string>();
  for (let i = at.startIdx + 1; i < at.endIdx; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    const m = t.match(/"([^"]+)"/);
    if (m) existing.add(m[1]);
    body.push(t.replace(/,\s*$/, ''));
  }
  const toAdd = newEntries.filter((e) => !existing.has(e));
  if (toAdd.length === 0) return;
  for (const e of toAdd) body.push(`"${e}"`);

  const indent = lines[at.startIdx + 1]?.match(/^(\s*)/)?.[1] || '    ';
  const rebuilt = body.map((entry, idx) => `${indent}${entry}${idx === body.length - 1 ? '' : ','}`);
  const out = [...lines.slice(0, at.startIdx + 1), ...rebuilt, ...lines.slice(at.endIdx)];
  writeFileSync(filePath, out.join('\n'));
}
