import { parseArgs } from 'node:util';
import {
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { Command } from '../command';

const USAGE = [
  'harness.dev — scaffold a new harness project (the default action)',
  '',
  'Usage:',
  '  npx harness.dev <name> [--dir <path>]',
  '',
  'Arguments:',
  '  <name>        Harness project name — also the directory created.',
  '',
  'Options:',
  '  --dir <path>  Parent directory to create the harness in (default: cwd)',
  '  -h, --help    Show this help',
  '',
  'Emits a runnable harness: a parallel research pool + synth over a resident',
  'model (fetched + verified on first run — no API key), wired to the signed',
  'lloyal/wikipedia app. Run `npm install && npm start`.',
].join('\n');

// Same grammar as `harness.dev app`: identifier-safe lowercase that
// satisfies both directory and npm package-name conventions.
const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;

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
      },
      allowPositionals: true,
    });

    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    const name = positionals[0];
    if (!name) {
      process.stderr.write('harness.dev: missing harness <name>\n\n' + USAGE + '\n');
      return 1;
    }
    if (!NAME_RE.test(name)) {
      process.stderr.write(
        `harness.dev: invalid <name> "${name}" — expected [a-z][a-z0-9_-]{1,63}.\n`,
      );
      return 1;
    }

    const parentDir = resolve(values.dir ?? process.cwd());
    const dest = join(parentDir, name);

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

    const templateDir = resolveTemplateDir('blank');
    const substitutions = buildSubstitutions(name);

    try {
      copyTreeWithSubstitutions(templateDir, dest, substitutions);
    } catch (err) {
      process.stderr.write(
        `harness.dev: scaffold failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }

    process.stdout.write(
      `scaffolded ${name} at ${dest}\n` +
        '  next steps:\n' +
        `    cd ${name}\n` +
        '    npm install\n' +
        '    npm start\n' +
        '\n' +
        '  No API key needed — the model is fetched + digest-verified on first\n' +
        '  run and runs inside your app. The lloyal/wikipedia app is preinstalled;\n' +
        '  add more via: npx harness.dev install <publisher>/<name>\n',
    );
    return 0;
  },
};

/**
 * Resolve the templates directory by walking up from this module's
 * compiled location. After build, the CLI lives at
 * `<pkg-root>/dist/commands/create.js`, so the templates are at
 * `<pkg-root>/templates/<kind>`.
 */
function resolveTemplateDir(kind: 'app' | 'harness' | 'blank'): string {
  const here = __dirname;
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
    __NAME_PASCAL__: pascalCase(name),
  };
}

function pascalCase(s: string): string {
  return s
    .split(/[-_]/g)
    .filter((seg) => seg.length > 0)
    .map((seg) => seg[0].toUpperCase() + seg.slice(1))
    .join('');
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
