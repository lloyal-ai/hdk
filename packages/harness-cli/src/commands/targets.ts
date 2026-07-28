/**
 * `targets:` — manage the run surfaces of a scaffolded project.
 *
 * A "target" is a surface = (binding + view): `cli` (terminal), `desktop`
 * (native window), `web` (browser + host). `cli` is mandatory (it carries the
 * engine bin). `targets:add` is the exact inverse of the scaffolder's prune —
 * it copies the surface back from the SAME template the project came from (read
 * from the `harnessdev.template` marker), so a `web` surface added to a research
 * project folds research's own views. `targets:remove` wraps the prune.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import type { Command } from '../command.js';
import { harnessProjectRoot } from '../scaffold/project.js';
import { pruneTargets, type PrunableTarget, type Target } from '../scaffold/prune-targets.js';
import { addTarget, presentTargets } from '../scaffold/add-target.js';
import { readProjectMarker, setMarkerTargets } from '../scaffold/write-marker.js';

const PRUNABLE: readonly PrunableTarget[] = ['desktop', 'web'];

function parsePrunable(value: string | undefined): PrunableTarget {
  if (value === 'cli') {
    throw new Error('cli is mandatory (it carries the engine bin) and cannot be added or removed.');
  }
  if (value == null || !PRUNABLE.includes(value as PrunableTarget)) {
    throw new Error(`expected a target: ${PRUNABLE.join(' or ')}${value ? ` (got "${value}")` : ''}.`);
  }
  return value as PrunableTarget;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── targets:add ───────────────────────────────────────────────────────────────

const ADD_USAGE = [
  'harness.dev targets:add — add a run surface to the current project',
  '',
  'Usage:',
  '  npx harness.dev targets:add <desktop|web>',
  '',
  'Copies the surface (dir + build config + deps + tsconfig entries) back from the',
  'template this project was scaffolded from. The reverse of removing it.',
].join('\n');

export const targetsAddCommand: Command = {
  name: 'targets:add',
  summary: 'Add a run surface (desktop|web) back to the current project',
  usage: ADD_USAGE,
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
    if (values.help) return print(ADD_USAGE);
    try {
      const root = harnessProjectRoot();
      const target = parsePrunable(positionals[0]);
      const marker = readProjectMarker(root);
      if (!marker) {
        throw new Error(
          'no `harnessdev.template` marker in package.json — cannot tell which template to copy the ' +
            'surface from. Add `"harnessdev": { "template": "blank" }` (or "research") to package.json.',
        );
      }
      const after = addTarget(root, target, marker.template);
      setMarkerTargets(root, after);
      process.stdout.write(
        `added ${target} → targets: [${after.join(', ')}]\n` +
          `  run \`npm install\` to pull its deps, then \`npm run ${target === 'web' ? 'serve' : `dev:${target}`}\`.\n`,
      );
      return 0;
    } catch (err) {
      process.stderr.write(`harness.dev targets:add: ${asMessage(err)}\n`);
      return 1;
    }
  },
};

// ── targets:remove ────────────────────────────────────────────────────────────

const REMOVE_USAGE = [
  'harness.dev targets:remove — remove a run surface from the current project',
  '',
  'Usage:',
  '  npx harness.dev targets:remove <desktop|web> [--yes]',
  '',
  'Deletes the surface dir + its scripts/deps/tsconfig entries. Destructive —',
  'prompts for confirmation (pass --yes to skip, required in a non-interactive shell).',
].join('\n');

export const targetsRemoveCommand: Command = {
  name: 'targets:remove',
  summary: 'Remove a run surface (desktop|web) from the current project',
  usage: REMOVE_USAGE,
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { help: { type: 'boolean', short: 'h' }, yes: { type: 'boolean', short: 'y' } },
      allowPositionals: true,
    });
    if (values.help) return print(REMOVE_USAGE);
    try {
      const root = harnessProjectRoot();
      const target = parsePrunable(positionals[0]);
      const present = presentTargets(root);
      if (!present.includes(target)) {
        throw new Error(`target "${target}" is not present — nothing to remove.`);
      }
      if (!values.yes) {
        if (!process.stdin.isTTY) {
          throw new Error(`removing "${target}" deletes generated source — pass --yes to confirm in a non-interactive shell.`);
        }
        const ok = await confirm(`Remove target "${target}"? This deletes targets/${target}/ and its build config.`);
        if (!ok) {
          process.stderr.write('cancelled.\n');
          return 1;
        }
      }
      const remaining = present.filter((t) => t !== target) as Target[];
      pruneTargets(root, remaining);
      setMarkerTargets(root, remaining);
      process.stdout.write(`removed ${target} → targets: [${remaining.join(', ')}]\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`harness.dev targets:remove: ${asMessage(err)}\n`);
      return 1;
    }
  },
};

// ── targets:list ──────────────────────────────────────────────────────────────

const LIST_USAGE = [
  'harness.dev targets:list — show the run surfaces present in the current project',
  '',
  'Usage:',
  '  npx harness.dev targets:list',
].join('\n');

export const targetsListCommand: Command = {
  name: 'targets:list',
  summary: 'Show the run surfaces present in the current project',
  usage: LIST_USAGE,
  async run(argv) {
    const { values } = parseArgs({ args: [...argv], options: { help: { type: 'boolean', short: 'h' } } });
    if (values.help) return print(LIST_USAGE);
    try {
      const root = harnessProjectRoot();
      const present = new Set(presentTargets(root));
      const marker = readProjectMarker(root);
      const out: string[] = [];
      if (marker) out.push(`template: ${marker.template}`, '');
      out.push('Targets:');
      for (const t of ['cli', 'desktop', 'web'] as Target[]) {
        out.push(`  ${present.has(t) ? '●' : '○'} ${t}${t === 'cli' ? '  (required)' : present.has(t) ? '' : '  — add with targets:add'}`);
      }
      process.stdout.write(`${out.join('\n')}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`harness.dev targets:list: ${asMessage(err)}\n`);
      return 1;
    }
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function print(usage: string): number {
  process.stdout.write(`${usage}\n`);
  return 0;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

/** All three `targets:` verbs, in listing order. */
export const targetsCommands: readonly Command[] = [
  targetsAddCommand,
  targetsRemoveCommand,
  targetsListCommand,
];
