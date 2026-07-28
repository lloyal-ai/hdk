/**
 * Write the chosen model into a scaffolded project's `harness.yml`.
 *
 * A targeted line edit — NOT a YAML parse/re-serialize — so every guidance
 * comment in the template's `harness.yml` (the `kvCache`/`gpu`/`branches` hints,
 * the reranker note) survives untouched. Only the llm entry (and, when given,
 * `context:`) inside the `model.llm:` block is rewritten.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ModelChoice {
  /**
   * The trunk llm — either a catalog `id` (rig fetches + digest-verifies,
   * fail-closed) or a local `path` to a `.gguf` you already have (BYO, trusted
   * by possession). Path-shaped values are written as `path:`, everything else
   * as `id:` — see {@link isModelPath}.
   */
  llm: string;
  /** Optional `model.llm.context` (nCtx). Omit to leave the template default. */
  context?: number;
}

/**
 * A model value is a BYO **path** (not a catalog id) if it looks like a
 * filesystem path: it contains a slash, ends in `.gguf`, or starts with `~`.
 * Catalog ids are bare slugs (`reasoning-4b`) and stay ids even when unknown to
 * the vendored catalog, so the picker survives catalog drift. This is the fix
 * for the bug where a BYO `./x.gguf` was written as `id:` and rig then looked
 * for `models/llm/./x.gguf.gguf`.
 */
export function isModelPath(value: string): boolean {
  return /[\\/]/.test(value) || value.endsWith('.gguf') || value.startsWith('~');
}

/**
 * Rewrite the llm entry (+ optional `context`) in `<projectDir>/harness.yml`.
 * A catalog id keeps the `id:` key and swaps the value; a BYO path swaps BOTH
 * the key → `path:` and the value (a model entry is `{ id | path }`, never
 * both). Throws if the file has no `model.llm:` block. The reranker is NOT
 * written here — apps declare it and it auto-provisions from the catalog
 * default; the template's reranker note documents how to pin one.
 */
export function applyModelChoice(projectDir: string, choice: ModelChoice): void {
  const ymlPath = join(projectDir, 'harness.yml');
  const lines = readFileSync(ymlPath, 'utf8').split('\n');

  const llmIdx = lines.findIndex((l) => /^\s*llm:\s*$/.test(l));
  if (llmIdx === -1) {
    throw new Error(`applyModelChoice: no \`model.llm:\` block in ${ymlPath}`);
  }

  const asPath = isModelPath(choice.llm);
  // Scan forward from `llm:` and rewrite the FIRST entry line — the template
  // ships either `id:` or `path:`; we normalize to the right one for this
  // choice. `context:` appears only in the llm block, so the first match is
  // unambiguous. Both preserve any trailing guidance comment. Replace once.
  const key = asPath ? 'path' : 'id';
  let keyDone = false;
  let ctxDone = choice.context == null;
  for (let i = llmIdx + 1; i < lines.length && !(keyDone && ctxDone); i++) {
    if (!keyDone && /^\s+(?:id|path):\s*"[^"]*"/.test(lines[i])) {
      // JSON.stringify quotes + escapes the value — YAML 1.2 double-quoted
      // strings share JSON's escape sequences, so a Windows path (`C:\x.gguf`),
      // a `"`, or a newline round-trips correctly. A replacer fn (not a string)
      // keeps a `$` in the value from being read as a replace token.
      lines[i] = lines[i].replace(
        /^(\s+)(?:id|path):(\s*)"[^"]*"/,
        (_m, indent: string, sp: string) => `${indent}${key}:${sp}${JSON.stringify(choice.llm)}`,
      );
      keyDone = true;
      continue;
    }
    if (!ctxDone && /^\s+context:\s*\d+/.test(lines[i])) {
      lines[i] = lines[i].replace(/context:\s*\d+/, `context: ${choice.context}`);
      ctxDone = true;
    }
  }
  if (!keyDone) {
    throw new Error(`applyModelChoice: no \`id:\`/\`path:\` under \`model.llm:\` in ${ymlPath}`);
  }

  writeFileSync(ymlPath, lines.join('\n'));
}
