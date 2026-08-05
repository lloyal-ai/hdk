/**
 * Shared scaffolding primitives: locate a template directory and copy a tree
 * with `__TOKEN__` substitutions. Used by `new` (copies a whole template) and
 * by `targets:add` (copies one target subtree back from the originating
 * template). Kept here — not in a command module — so both share one copier and
 * one token set (`__NAME__` today).
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a template directory by walking up from this compiled module. After
 * build the CLI lives at `<pkg>/dist/scaffold/copy-tree.js`, so the templates
 * are at `<pkg>/templates/<kind>`; a second candidate covers a flatter layout.
 */
export function resolveTemplateDir(kind: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'templates', kind),
    resolve(here, '..', 'templates', kind),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      // try next
    }
  }
  throw new Error(`templates/${kind} not found relative to ${here}`);
}

/** The `__TOKEN__` → value map applied to every copied file + filename. */
export function buildSubstitutions(name: string): Record<string, string> {
  return {
    __NAME__: name,
  };
}

/**
 * Template filenames that must land in the scaffold as dotfiles.
 *
 * npm silently drops a nested `.gitignore` from the published tarball — even
 * when it is named explicitly in `files` — so a template that stores one under
 * its real name ships it to anyone running from a git checkout and to NOBODY
 * running `npx harness.dev`. Store it undotted in the template and restore the
 * dot here, so the published CLI and the repo emit the same tree.
 */
const DOTFILES: Record<string, string> = {
  gitignore: '.gitignore',
};

/** Recursively copy `src` → `dest`, applying `substitutions` to paths + text. */
export function copyTreeWithSubstitutions(
  src: string,
  dest: string,
  substitutions: Record<string, string>,
): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const fromPath = join(src, entry.name);
    const toName = DOTFILES[entry.name] ?? applySubstitutions(entry.name, substitutions);
    const toPath = join(dest, toName);

    if (entry.isDirectory()) {
      copyTreeWithSubstitutions(fromPath, toPath, substitutions);
      continue;
    }
    if (!entry.isFile()) continue;
    copyFileWithSubstitutions(fromPath, toPath, substitutions);
  }
}

/** Copy one file, applying `__TOKEN__` substitutions to its text. */
export function copyFileWithSubstitutions(
  src: string,
  dest: string,
  substitutions: Record<string, string>,
): void {
  const raw = readFileSync(src, 'utf-8');
  const rendered = applySubstitutions(raw, substitutions);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, rendered, 'utf-8');
}

function applySubstitutions(s: string, substitutions: Record<string, string>): string {
  let out = s;
  for (const [token, value] of Object.entries(substitutions)) {
    out = out.split(token).join(value);
  }
  return out;
}
