/**
 * Write the chosen model into a scaffolded project's `harness.yml`.
 *
 * A targeted line edit — NOT a YAML parse/re-serialize — so every guidance
 * comment in the template's `harness.yml` (the `kvCache`/`gpu`/`branches` hints,
 * the reranker note) survives untouched. Only the llm `id:` value (and, when
 * given, `context:`) inside the `model.llm:` block is rewritten.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ModelChoice {
  /** Catalog id (or path) for the trunk llm — replaces `model.llm.id`. */
  llmId: string;
  /** Optional `model.llm.context` (nCtx). Omit to leave the template default. */
  context?: number;
}

/**
 * Rewrite `model.llm.id` (+ optional `context`) in `<projectDir>/harness.yml`.
 * Throws if the file has no `model.llm:` block. The reranker is NOT written
 * here — apps declare it and it auto-provisions from the catalog default; the
 * template's reranker note documents how to pin one.
 */
export function applyModelChoice(projectDir: string, choice: ModelChoice): void {
  const ymlPath = join(projectDir, 'harness.yml');
  const lines = readFileSync(ymlPath, 'utf8').split('\n');

  const llmIdx = lines.findIndex((l) => /^\s*llm:\s*$/.test(l));
  if (llmIdx === -1) {
    throw new Error(`applyModelChoice: no \`model.llm:\` block in ${ymlPath}`);
  }

  // Scan forward from `llm:` and rewrite the FIRST `id:` (the llm's) — a value-
  // only replace so any trailing comment stays. `context:` appears only in the
  // llm block, so the first match is unambiguous. Replace each at most once.
  let idDone = false;
  let ctxDone = choice.context == null;
  for (let i = llmIdx + 1; i < lines.length && !(idDone && ctxDone); i++) {
    if (!idDone && /^\s+id:\s*"[^"]*"/.test(lines[i])) {
      lines[i] = lines[i].replace(/"[^"]*"/, `"${choice.llmId}"`);
      idDone = true;
      continue;
    }
    if (!ctxDone && /^\s+context:\s*\d+/.test(lines[i])) {
      lines[i] = lines[i].replace(/context:\s*\d+/, `context: ${choice.context}`);
      ctxDone = true;
    }
  }
  if (!idDone) {
    throw new Error(`applyModelChoice: no \`id:\` under \`model.llm:\` in ${ymlPath}`);
  }

  writeFileSync(ymlPath, lines.join('\n'));
}
