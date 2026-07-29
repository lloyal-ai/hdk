/**
 * Write a chosen model into a scaffolded project's `harness.yml`.
 *
 * A targeted line edit — NOT a YAML parse/re-serialize — so every guidance
 * comment in the template's `harness.yml` (the `kvCache`/`gpu`/`branches` hints,
 * the reranker note) survives untouched. This is the single write path the
 * `models:` verbs (`models:use`/`add`/`download`) and the scaffolder share, so
 * the yml is never hand-edited.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A model entry is `id` XOR `path` — a catalog id or a BYO `.gguf` path. */
export type ModelSpec = { id: string } | { path: string };

/** The roles a harness provisions: the trunk llm + an app-declared reranker. */
export type Role = 'llm' | 'reranker';

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
 * Catalog ids are bare slugs (`qwen3.5-4b`) and stay ids even when unknown to
 * the vendored catalog, so the picker survives catalog drift. This is the fix
 * for the bug where a BYO `./x.gguf` was written as `id:` and rig then looked
 * for `models/llm/./x.gguf.gguf`.
 */
export function isModelPath(value: string): boolean {
  return /[\\/]/.test(value) || value.endsWith('.gguf') || value.startsWith('~');
}

/** Turn a raw model value into a spec, classifying id vs BYO path. */
export function specFromValue(value: string): ModelSpec {
  return isModelPath(value) ? { path: value } : { id: value };
}

/**
 * Write `model.<role>` in `<projectDir>/harness.yml`. A catalog id keeps/sets
 * the `id:` key; a BYO path keeps/sets `path:` (an entry is `{ id | path }`,
 * never both — the opposite key is swapped, not left dangling). Two block
 * states are handled:
 *   - the `<role>:` block is present (llm always; research's reranker) → the
 *     first entry line is rewritten in place, preserving its trailing comment;
 *   - the block is absent or commented (basic ships its `reranker:` commented)
 *     → a fresh `  <role>:` block is inserted into `model:`.
 * `opts.context` updates the llm's `context:` line (only meaningful for llm).
 * Throws if there is no `model:` block at all.
 */
export function writeModelField(
  projectDir: string,
  role: Role,
  spec: ModelSpec,
  opts: { context?: number } = {},
): void {
  const ymlPath = join(projectDir, 'harness.yml');
  const lines = readFileSync(ymlPath, 'utf8').split('\n');

  const key = 'id' in spec ? 'id' : 'path';
  const value = 'id' in spec ? spec.id : spec.path;

  const modelIdx = lines.findIndex((l) => /^model:\s*$/.test(l));
  if (modelIdx === -1) {
    throw new Error(`writeModelField: no \`model:\` block in ${ymlPath}`);
  }
  const blockEnd = findBlockEnd(lines, modelIdx);

  // A LIVE (uncommented) `<role>:` header inside the model: block.
  const roleRe = new RegExp(`^(\\s+)${role}:\\s*$`);
  let roleIdx = -1;
  let roleIndent = '  ';
  for (let i = modelIdx + 1; i < blockEnd; i++) {
    const m = lines[i].match(roleRe);
    if (m) {
      roleIdx = i;
      roleIndent = m[1];
      break;
    }
  }

  if (roleIdx !== -1) {
    rewriteEntry(lines, roleIdx, blockEnd, key, value, roleIndent, {
      context: role === 'llm' ? opts.context : undefined,
    });
  } else {
    insertBlock(lines, modelIdx, blockEnd, role, key, value);
  }

  writeFileSync(ymlPath, lines.join('\n'));
}

/**
 * Rewrite the llm entry (+ optional `context`) in `<projectDir>/harness.yml` —
 * the scaffolder's llm-only convenience over {@link writeModelField}.
 */
export function applyModelChoice(projectDir: string, choice: ModelChoice): void {
  writeModelField(projectDir, 'llm', specFromValue(choice.llm), { context: choice.context });
}

/**
 * Read the active `model.<role>` pin from `<projectDir>/harness.yml` — the
 * inverse of {@link writeModelField}, used by `models:list`. Returns the first
 * `id:`/`path:` entry under a LIVE `<role>:` block, or `null` when the role is
 * unset (absent or commented). A light regex read (not a YAML parse) — no dep.
 */
export function readModelField(projectDir: string, role: Role): ModelSpec | null {
  const ymlPath = join(projectDir, 'harness.yml');
  const lines = readFileSync(ymlPath, 'utf8').split('\n');
  const modelIdx = lines.findIndex((l) => /^model:\s*$/.test(l));
  if (modelIdx === -1) return null;
  const blockEnd = findBlockEnd(lines, modelIdx);

  const roleRe = new RegExp(`^(\\s+)${role}:\\s*$`);
  for (let i = modelIdx + 1; i < blockEnd; i++) {
    const m = lines[i].match(roleRe);
    if (!m) continue;
    const subEnd = subBlockEnd(lines, i, blockEnd, m[1].length);
    for (let j = i + 1; j < subEnd; j++) {
      // Match a full double-quoted token INCLUDING escapes (`\"`, `\\`) so a
      // value written via JSON.stringify (a Windows path, an embedded quote)
      // isn't truncated at its first inner quote; JSON.parse un-escapes it back
      // to the real value (YAML 1.2 double-quoted strings share JSON escapes).
      const entry = lines[j].match(/^\s+(id|path):\s*("(?:[^"\\]|\\.)*")/);
      if (entry) {
        const value = JSON.parse(entry[2]) as string;
        return entry[1] === 'id' ? { id: value } : { path: value };
      }
    }
    return null;
  }
  return null;
}

/**
 * Exclusive end index of the block opened at `startIdx` (a top-level `key:`
 * line): the first later line that starts a NEW top-level key (column-0,
 * non-comment), else EOF. Indented lines and comments stay inside the block.
 */
function findBlockEnd(lines: readonly string[], startIdx: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 0 && !/^\s/.test(l) && !l.startsWith('#')) return i;
  }
  return lines.length;
}

/**
 * Rewrite the first `id:`/`path:` entry line (and, when given, `context:`)
 * inside the `<role>:` sub-block that opens at `roleIdx`. The key is normalized
 * to `key` (id↔path swap) and the value re-quoted; a trailing comment on the
 * line survives. If the block has a header but no entry line (an empty
 * `reranker:`), an entry is inserted directly under it.
 */
function rewriteEntry(
  lines: string[],
  roleIdx: number,
  blockEnd: number,
  key: 'id' | 'path',
  value: string,
  roleIndent: string,
  opts: { context?: number },
): void {
  const subEnd = subBlockEnd(lines, roleIdx, blockEnd, roleIndent.length);
  let keyDone = false;
  let ctxDone = opts.context == null;
  for (let i = roleIdx + 1; i < subEnd && !(keyDone && ctxDone); i++) {
    if (!keyDone && /^\s+(?:id|path):\s*"(?:[^"\\]|\\.)*"/.test(lines[i])) {
      // JSON.stringify quotes + escapes the value — YAML 1.2 double-quoted
      // strings share JSON's escape sequences, so a Windows path (`C:\x.gguf`),
      // a `"`, or a newline round-trips correctly. The value match spans escapes
      // (`\"`, `\\`) so re-writing OVER an already-escaped value doesn't corrupt
      // it. A replacer fn (not a string) keeps a `$` in the value from being
      // read as a replace token.
      lines[i] = lines[i].replace(
        /^(\s+)(?:id|path):(\s*)"(?:[^"\\]|\\.)*"/,
        (_m, indent: string, sp: string) => `${indent}${key}:${sp}${JSON.stringify(value)}`,
      );
      keyDone = true;
      continue;
    }
    if (!ctxDone && /^\s+context:\s*\d+/.test(lines[i])) {
      lines[i] = lines[i].replace(/context:\s*\d+/, `context: ${opts.context}`);
      ctxDone = true;
    }
  }
  if (!keyDone) {
    // Header present but no entry line — insert one under the header.
    lines.splice(roleIdx + 1, 0, `${roleIndent}  ${key}: ${JSON.stringify(value)}`);
  }
}

/**
 * Exclusive end of the sub-block opened at `roleIdx`: the first later line
 * (inside `blockEnd`) whose leading indent is `<= indentLen` — a sibling key or
 * a dedent. Blank lines never terminate a sub-block.
 */
function subBlockEnd(
  lines: readonly string[],
  roleIdx: number,
  blockEnd: number,
  indentLen: number,
): number {
  for (let i = roleIdx + 1; i < blockEnd; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (l.match(/^\s*/)![0].length <= indentLen) return i;
  }
  return blockEnd;
}

/**
 * Insert a fresh `  <role>:\n    <key>: "<value>"` block into `model:`, right
 * after its last real (indented, non-comment) child — so the live block lands
 * next to the llm entry, before any commented guidance.
 */
function insertBlock(
  lines: string[],
  modelIdx: number,
  blockEnd: number,
  role: string,
  key: 'id' | 'path',
  value: string,
): void {
  let insertAt = modelIdx + 1;
  let childIndent = '  ';
  let sawChild = false;
  for (let i = modelIdx + 1; i < blockEnd; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const m = l.match(/^(\s+)\S/);
    if (m) {
      if (!sawChild) {
        childIndent = m[1];
        sawChild = true;
      }
      insertAt = i + 1;
    }
  }
  lines.splice(insertAt, 0, `${childIndent}${role}:`, `${childIndent}  ${key}: ${JSON.stringify(value)}`);
}
