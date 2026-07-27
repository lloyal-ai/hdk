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
import { runCreateWizard, type TemplateKind } from './create-wizard.js';

const USAGE = [
  'harness.dev create — scaffold a new harness project',
  '',
  'Usage:',
  '  npx harness.dev create                      Interactive: name → targets → model → template',
  '  npx harness.dev create <name> [options]     Non-interactive (flags below)',
  '',
  'Arguments:',
  '  <name>        Harness project name — also the directory created.',
  '',
  'Options:',
  '  --template <blank|research>',
  '                Starting point (default: blank). blank = a minimal parallel',
  '                pool + synth; research = the tuned recon→plan→agents→synth',
  '                pipeline (grounded multi-agent research).',
  '  --targets <list>',
  '                Comma-separated run surfaces to keep (default: cli,desktop,web).',
  '                cli is always included; the rest are pruned from the scaffold.',
  '  --model <id>  Trunk model id (default: the catalog default). See the catalog',
  '                with the interactive picker.',
  '  --dir <path>  Parent directory to create the harness in (default: cwd)',
  '  -h, --help    Show this help',
  '',
  'Emits a runnable harness on the selected surfaces, on a resident model (fetched',
  '+ verified on first run — no API key). Run `npm install && npm start`.',
].join('\n');

// Same grammar as `harness.dev app`: identifier-safe lowercase that
// satisfies both directory and npm package-name conventions.
const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const ALL_TARGETS: Target[] = ['cli', 'desktop', 'web'];

interface ScaffoldPlan {
  name: string;
  template: TemplateKind;
  targets: Target[];
  llmId: string;
}

export const createCommand: Command = {
  name: 'create',
  summary: 'Scaffold a new harness (the default action — name is optional verb)',
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
      },
      allowPositionals: true,
    });

    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    const parentDir = resolve(values.dir ?? process.cwd());
    const name = positionals[0];

    // Interactive picker: a bare `harness.dev create` in a TTY. A provided name
    // (or a non-TTY / piped stdin — CI) takes the flag path below.
    let plan: ScaffoldPlan;
    if (!name && process.stdin.isTTY) {
      const result = await runCreateWizard();
      if (!result) {
        process.stderr.write('create cancelled.\n');
        return 1;
      }
      plan = result;
    } else {
      const built = planFromFlags(name, values);
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

/** Build a scaffold plan from CLI flags (the non-interactive path). */
function planFromFlags(
  name: string | undefined,
  values: { template?: string; targets?: string; model?: string },
): ScaffoldPlan | { error: string; usage?: boolean } {
  if (!name) {
    return { error: 'harness.dev: missing harness <name>', usage: true };
  }
  if (!NAME_RE.test(name)) {
    return { error: `harness.dev: invalid <name> "${name}" — expected [a-z][a-z0-9_-]{1,63}.` };
  }

  const template = (values.template ?? 'blank') as TemplateKind;
  if (template !== 'blank' && template !== 'research') {
    return { error: `harness.dev: invalid --template "${values.template}" — expected "blank" or "research".` };
  }

  const targets = parseTargets(values.targets);
  if ('error' in targets) return { error: `harness.dev: ${targets.error}` };

  const llmId = values.model ?? modelsForRole('llm')[0]?.id ?? 'reasoning-4b';

  return { name, template, targets: targets.targets, llmId };
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

  try {
    if (statSync(dest).isDirectory()) {
      process.stderr.write(
        `harness.dev: ${dest} already exists. Choose a different name or remove the directory first.\n`,
      );
      return 1;
    }
  } catch {
    // ENOENT — good
  }

  const templateDir = resolveTemplateDir(plan.template);
  try {
    copyTreeWithSubstitutions(templateDir, dest, buildSubstitutions(plan.name));
    if (plan.targets.length < ALL_TARGETS.length) {
      pruneTargets(dest, plan.targets);
    }
    const recommendedContext = MODEL_CATALOG.find(
      (m) => m.role === 'llm' && m.id === plan.llmId,
    )?.recommendedContext;
    applyModelChoice(dest, { llmId: plan.llmId, context: recommendedContext });
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
      `  targets: ${plan.targets.join(', ')} · model: ${plan.llmId}\n` +
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
 * `<pkg-root>/dist/commands/create.js`, so the templates are at
 * `<pkg-root>/templates/<kind>`.
 */
function resolveTemplateDir(kind: 'app' | 'harness' | 'blank' | 'research'): string {
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
