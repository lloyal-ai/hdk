import { parseArgs } from 'node:util';
import {
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '../command.js';
import { pruneTargets, type Target } from '../scaffold/prune-targets.js';
import { applyModelChoice } from '../scaffold/apply-model.js';
import { MODEL_CATALOG, modelsForRole } from '../scaffold/model-catalog.js';
import { runNewWizard, type TemplateKind, type WizardPrefill } from './new-wizard.js';

const USAGE = [
  'harness.dev new — scaffold a new harness project',
  '',
  'Usage:',
  '  npx harness.dev new                         Interactive: name → targets → model → template',
  '  npx harness.dev new <name> [options]        Non-interactive (flags below)',
  '',
  'Arguments:',
  '  <name>        Harness project name — also the directory created. Omit it in a',
  '                terminal to launch the interactive picker.',
  '',
  'Options:',
  '  --template <blank|research>',
  '                Starting point (default: blank). blank = a minimal parallel',
  '                pool + synth; research = the tuned recon→plan→agents→synth',
  '                pipeline (grounded multi-agent research).',
  '  --targets <list>',
  '                Comma-separated run surfaces to keep (default: cli,desktop,web).',
  '                cli is always included; the rest are pruned from the scaffold.',
  '  --model <id|path>',
  '                Trunk model — a catalog id (fetched + digest-verified) or a path',
  '                to a local .gguf you already have. Default: the catalog default.',
  '  --dir <path>  Parent directory to create the harness in (default: cwd)',
  '  -y, --yes     Skip the picker; accept defaults for anything not given a flag.',
  '  -h, --help    Show this help',
  '',
  'Any flags you pass also pre-seed the picker, so it prompts only for what is',
  'missing. Emits a runnable harness on the selected surfaces, on a resident model',
  '(fetched + verified on first run — no API key). Run `npm install && npm start`.',
].join('\n');

// Same grammar as `harness.dev app:new`: identifier-safe lowercase that
// satisfies both directory and npm package-name conventions.
const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const ALL_TARGETS: Target[] = ['cli', 'desktop', 'web'];

interface ScaffoldPlan {
  name: string;
  template: TemplateKind;
  targets: Target[];
  /** Catalog id OR a BYO `.gguf` path (see `applyModelChoice`). */
  llm: string;
}

/** Flags shared by both paths — undefined means "not provided" (ask / default). */
type Flags = WizardPrefill;

export const newCommand: Command = {
  name: 'new',
  summary: 'Scaffold a new harness (interactive when run without a name)',
  usage: USAGE,
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        dir: { type: 'string' },
        template: { type: 'string' },
        targets: { type: 'string' },
        model: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
      },
      allowPositionals: true,
    });

    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    const parentDir = resolve(values.dir ?? process.cwd());
    const name = positionals[0];

    // Validate any flags once — they seed BOTH the wizard (as a prefill) and the
    // non-interactive plan (with defaults filled in).
    const flags = validateFlags(values);
    if ('error' in flags) {
      process.stderr.write(`${flags.error}\n`);
      return 1;
    }

    // Interactive picker: a bare `harness.dev new` in a real terminal. A provided
    // name, `--yes`, or a non-TTY (CI, or stdin/stdout redirected) takes the flag
    // path below — Ink needs BOTH stdin and stdout to be a TTY, else its
    // keyboard/render UX is broken (piped output would get ANSI garbage). Any
    // flags already given pre-seed the picker so it asks only for the rest.
    const interactive =
      !name && !values.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    let plan: ScaffoldPlan;
    if (interactive) {
      const result = await runNewWizard(flags);
      if (!result) {
        process.stderr.write('cancelled.\n');
        return 1;
      }
      plan = result;
    } else {
      const built = planFromFlags(name, flags);
      if ('error' in built) {
        process.stderr.write(`${built.error}\n`);
        if (built.usage) process.stderr.write(`\n${USAGE}\n`);
        return 1;
      }
      plan = built;
    }

    return performScaffold(plan, parentDir);
  },
};

/** Validate provided flags without filling defaults (undefined = ask/default). */
function validateFlags(values: {
  template?: string;
  targets?: string;
  model?: string;
}): Flags | { error: string } {
  let template: TemplateKind | undefined;
  if (values.template != null) {
    if (values.template !== 'blank' && values.template !== 'research') {
      return { error: `harness.dev: invalid --template "${values.template}" — expected "blank" or "research".` };
    }
    template = values.template;
  }

  let targets: Target[] | undefined;
  if (values.targets != null) {
    const parsed = parseTargets(values.targets);
    if ('error' in parsed) return { error: `harness.dev: ${parsed.error}` };
    targets = parsed.targets;
  }

  // Trim `--model`; an empty/whitespace value is "not provided" (falls to the
  // catalog default) — `??` alone would treat `""` as a real id and write an
  // empty `model.llm`, breaking resolution.
  const llm = values.model?.trim();
  return { template, targets, llm: llm || undefined };
}

/** Build a scaffold plan from CLI flags (the non-interactive path). */
function planFromFlags(
  name: string | undefined,
  flags: Flags,
): ScaffoldPlan | { error: string; usage?: boolean } {
  if (!name) {
    return { error: 'harness.dev: missing harness <name>', usage: true };
  }
  if (!NAME_RE.test(name)) {
    return { error: `harness.dev: invalid <name> "${name}" — expected [a-z][a-z0-9_-]{1,63}.` };
  }

  return {
    name,
    template: flags.template ?? 'blank',
    targets: flags.targets ?? [...ALL_TARGETS],
    llm: flags.llm ?? modelsForRole('llm')[0]?.id ?? 'reasoning-4b',
  };
}

/** Parse a `--targets cli,web` list; cli is always retained. */
function parseTargets(csv: string | undefined): { targets: Target[] } | { error: string } {
  if (!csv) return { targets: [...ALL_TARGETS] };
  const parts = csv.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !ALL_TARGETS.includes(p as Target));
  if (bad.length) {
    return { error: `unknown --targets value(s): ${bad.join(', ')} — expected cli, desktop, web` };
  }
  const set = new Set(parts as Target[]);
  set.add('cli');
  return { targets: ALL_TARGETS.filter((t) => set.has(t)) };
}

/** Copy the template, prune to the selected targets, write the model. */
function performScaffold(plan: ScaffoldPlan, parentDir: string): number {
  const dest = join(parentDir, plan.name);

  // Refuse to clobber ANY existing path (dir, file, or symlink) — falling
  // through would fail later with a cryptic mkdirSync EEXIST/ENOTDIR. Only a
  // missing path (ENOENT) is safe; any other stat error is surfaced, not eaten.
  try {
    statSync(dest);
    process.stderr.write(
      `harness.dev: ${dest} already exists. Choose a different name or remove it first.\n`,
    );
    return 1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `harness.dev: cannot access ${dest}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
    // ENOENT — the destination is free.
  }

  const templateDir = resolveTemplateDir(plan.template);
  try {
    copyTreeWithSubstitutions(templateDir, dest, buildSubstitutions(plan.name));
    if (plan.targets.length < ALL_TARGETS.length) {
      pruneTargets(dest, plan.targets);
    }
    const recommendedContext = MODEL_CATALOG.find(
      (m) => m.role === 'llm' && m.id === plan.llm,
    )?.recommendedContext;
    applyModelChoice(dest, { llm: plan.llm, context: recommendedContext });
  } catch (err) {
    process.stderr.write(
      `harness.dev: scaffold failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const appsNote =
    plan.template === 'research'
      ? '  it runs inside your app. The lloyal/corpus + lloyal/web apps are\n' +
        '  preinstalled (grounded multi-agent research);\n'
      : '  it runs inside your app. The lloyal/wikipedia app is preinstalled;\n';

  process.stdout.write(
    `scaffolded ${plan.name} (${plan.template}) at ${dest}\n` +
      `  targets: ${plan.targets.join(', ')} · model: ${plan.llm}\n` +
      '  next steps:\n' +
      `    cd ${plan.name}\n` +
      '    npm install\n' +
      '    npm start\n' +
      '\n' +
      '  No API key needed — the model is fetched + digest-verified on first run;\n' +
      appsNote +
      '  add more via: npx harness.dev install <publisher>/<name>\n',
  );
  return 0;
}

/**
 * Resolve the templates directory by walking up from this module's
 * compiled location. After build, the CLI lives at
 * `<pkg-root>/dist/commands/new.js`, so the templates are at
 * `<pkg-root>/templates/<kind>`.
 */
function resolveTemplateDir(kind: TemplateKind): string {
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

function buildSubstitutions(name: string): Record<string, string> {
  return {
    __NAME__: name,
  };
}

function copyTreeWithSubstitutions(
  src: string,
  dest: string,
  substitutions: Record<string, string>,
): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const fromPath = join(src, entry.name);
    const toName = applySubstitutions(entry.name, substitutions);
    const toPath = join(dest, toName);

    if (entry.isDirectory()) {
      copyTreeWithSubstitutions(fromPath, toPath, substitutions);
      continue;
    }
    if (!entry.isFile()) continue;

    const raw = readFileSync(fromPath, 'utf-8');
    const rendered = applySubstitutions(raw, substitutions);
    mkdirSync(dirname(toPath), { recursive: true });
    writeFileSync(toPath, rendered, 'utf-8');
  }
}

function applySubstitutions(s: string, substitutions: Record<string, string>): string {
  let out = s;
  for (const [token, value] of Object.entries(substitutions)) {
    out = out.split(token).join(value);
  }
  return out;
}
