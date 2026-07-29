#!/usr/bin/env node
/**
 * `harness.dev` — the Harness Development Kit CLI.
 *
 * Thin dispatcher. The first token selects a command by name (`new`,
 * `app:new`, `install`, …); an unknown token is an ERROR, never a silent
 * scaffold. Scaffolding a harness is the explicit `new` verb.
 * Global `--help` / `--version` are handled here; all other flag parsing
 * belongs to the individual command.
 *
 * The package and the bin share the name `harness.dev`, so the
 * invocation is identical whether run via `npx harness.dev …` or as the
 * globally-installed `harness.dev …` command.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCommand } from './commands/index.js';

function version(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function printHelp(): void {
  process.stdout.write(
    [
      'harness.dev — Harness Development Kit CLI',
      '',
      'Scaffold:',
      '  npx harness.dev new [name]           Scaffold a new harness (interactive if no name)',
      '  npx harness.dev new --template research       Start from the tuned research template',
      '  npx harness.dev app:new <name>       Scaffold a new app',
      '',
      'Manage models (in a project):',
      '  npx harness.dev models:use <id> [--role llm|reranker]   Pin a catalog model',
      '  npx harness.dev models:add <path> [--role]              Register a local .gguf (BYO)',
      '  npx harness.dev models:download <url> [--role] [--sha256 <hex>]  Fetch a .gguf by URL',
      '  npx harness.dev models:list          Catalog ids, active pins, installed files',
      '',
      'Manage targets (run surfaces, in a project):',
      '  npx harness.dev targets:add <desktop|web>      Add a surface back',
      '  npx harness.dev targets:remove <desktop|web>   Remove a surface',
      '  npx harness.dev targets:list         Show the surfaces present',
      '',
      'Apps + channel:',
      '  npx harness.dev install <pub>/<name>[@<semver>]   Install a signed app from apps.lloyal.ai',
      '  npx harness.dev publish              Submit an app for review + signing',
      '  npx harness.dev publish status <id>  Check the status of a submission',
      '  npx harness.dev publishers register  Claim a publisher handle + attest ToS',
      '  npx harness.dev publishers me        Show your publisher record',
      '  npx harness.dev review <subcommand>  Lloyal-internal review surface',
      '',
      'After `npm i -g harness.dev`, drop the `npx ` prefix.',
      '',
      'Options:',
      '  -h, --help     Show this help',
      '  -v, --version  Print the version',
      '',
      'Run `npx harness.dev <command> --help` for command-specific options.',
      '',
    ].join('\n'),
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const [first, ...rest] = argv;

  if (first === '--version' || first === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    printHelp();
    return 0;
  }

  const named = findCommand(first);
  if (named) {
    return named.run(rest);
  }

  // Unknown command → error, NOT a silent scaffold. Scaffolding now requires the
  // explicit `new` verb (a bare `harness.dev my-harness` used to make a
  // directory, so a mistyped subcommand silently scaffolded one).
  const suggestion = first.startsWith('-') ? '' : ` Did you mean \`harness.dev new ${first}\`?`;
  process.stderr.write(
    `harness.dev: unknown command "${first}".${suggestion} Run \`harness.dev --help\` for usage.\n`,
  );
  return 1;
}

/**
 * Process entrypoint — turn argv into an exit code. Called by the `bin/run.js`
 * shim, which is the CLI's only executable. Keeping this here (not in the shim)
 * means all logic and its types live in one place and the shim stays a dumb
 * loader; keeping it OFF module top-level means importing `cli.ts` (from a test,
 * say) has no side effects. `main` stays pure — it returns a code — while `run`
 * owns the process glue.
 */
export async function run(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
