/**
 * `models:` — manage the model bindings in a scaffolded project's `harness.yml`.
 *
 * Config is the source of truth: `model.<role>.{ id | path }` — an `id` is a
 * catalog model (rig fetches + digest-verifies, fail-closed, on next run); a
 * `path` is a BYO `.gguf` (trusted by possession). These verbs OWN the write, so
 * the yml is never hand-edited. `<role>` is the trunk `llm` (default) or a
 * `reranker` (the model behind an app-declared service).
 *
 * `models:download` streams a `.gguf` from a URL into `models/<role>/` with a
 * zero-native-dep fetch (same Apache posture as `install.ts`), NEVER buffering
 * the whole multi-GB weight into memory.
 */
import { parseArgs } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink, stat } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import type { Command } from '../command.js';
import { harnessProjectRoot } from '../scaffold/project.js';
import {
  writeModelField,
  readModelField,
  isModelPath,
  type Role,
} from '../scaffold/apply-model.js';
import { MODEL_CATALOG, modelsForRole } from '../scaffold/model-catalog.js';
import { httpFetch } from '../http.js';

const ROLES: readonly Role[] = ['llm', 'reranker'];

/** Parse `--role`, defaulting to the trunk `llm`. Throws on an unknown role. */
function parseRole(value: string | undefined): Role {
  if (value == null) return 'llm';
  if (!ROLES.includes(value as Role)) {
    throw new Error(`invalid --role "${value}" — expected ${ROLES.join(' or ')}.`);
  }
  return value as Role;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── models:use ──────────────────────────────────────────────────────────────

const USE_USAGE = [
  'harness.dev models:use — pin a catalog model by id',
  '',
  'Usage:',
  '  npx harness.dev models:use <id> [--role llm|reranker]',
  '',
  'Writes `model.<role>.id` in harness.yml. The model is fetched + digest-verified',
  'from the catalog on the next run (no API key). For a local .gguf you already',
  'have, use `models:add <path>` instead.',
].join('\n');

export const modelsUseCommand: Command = {
  name: 'models:use',
  summary: 'Pin a catalog model by id (fetched + verified on next run)',
  usage: USE_USAGE,
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { help: { type: 'boolean', short: 'h' }, role: { type: 'string' } },
      allowPositionals: true,
    });
    if (values.help) return print(USE_USAGE);
    try {
      const root = harnessProjectRoot();
      const role = parseRole(values.role);
      const id = positionals[0];
      if (!id) throw new Error('missing <id>. Usage: harness.dev models:use <id> [--role]');
      if (isModelPath(id)) {
        throw new Error(`"${id}" looks like a path — use \`harness.dev models:add ${id}\` for a BYO .gguf.`);
      }
      if (!modelsForRole(role).some((m) => m.id === id)) {
        process.stderr.write(
          `note: "${id}" is not in the vendored catalog for role ${role}; it will fail-closed on ` +
            'fetch if it is not a real catalog id. Run `harness.dev models:list` to see known ids.\n',
        );
      }
      writeModelField(root, role, { id });
      process.stdout.write(`model.${role}.id = ${id}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`harness.dev models:use: ${asMessage(err)}\n`);
      return 1;
    }
  },
};

// ── models:add ──────────────────────────────────────────────────────────────

const ADD_USAGE = [
  'harness.dev models:add — register a local .gguf you already have',
  '',
  'Usage:',
  '  npx harness.dev models:add <path> [--role llm|reranker]',
  '',
  'Writes `model.<role>.path` in harness.yml. The file is trusted by possession',
  '(not catalog-digest-verified). Relative paths resolve from the project root.',
].join('\n');

export const modelsAddCommand: Command = {
  name: 'models:add',
  summary: 'Register a local .gguf you already have (BYO, trusted by possession)',
  usage: ADD_USAGE,
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { help: { type: 'boolean', short: 'h' }, role: { type: 'string' } },
      allowPositionals: true,
    });
    if (values.help) return print(ADD_USAGE);
    try {
      const root = harnessProjectRoot();
      const role = parseRole(values.role);
      const path = positionals[0];
      if (!path) throw new Error('missing <path>. Usage: harness.dev models:add <path> [--role]');
      // Warn (don't block) if the file isn't there yet — trusted by possession,
      // but a typo is worth flagging before the next run fails to load.
      // `isAbsolute` is platform-aware (handles Windows drive/UNC paths); `~`
      // isn't "absolute" but points outside the project, so leave it as-is too.
      const abs = isAbsolute(path) || path.startsWith('~') ? path : join(root, path);
      if (!existsSync(abs)) {
        process.stderr.write(`note: ${path} does not exist yet — the next run will fail to load until it does.\n`);
      }
      writeModelField(root, role, { path });
      process.stdout.write(`model.${role}.path = ${path}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`harness.dev models:add: ${asMessage(err)}\n`);
      return 1;
    }
  },
};

// ── models:download ───────────────────────────────────────────────────────────

const DOWNLOAD_USAGE = [
  'harness.dev models:download — fetch a .gguf from a URL into models/<role>/',
  '',
  'Usage:',
  '  npx harness.dev models:download <url> [--role llm|reranker] [--sha256 <hex>]',
  '',
  'Streams the weight to models/<role>/<file>.gguf and pins it as model.<role>.path.',
  'A URL download is TRUSTED BY SOURCE — pass --sha256 to verify the bytes',
  '(fail-closed: a mismatch deletes the file and errors).',
].join('\n');

export const modelsDownloadCommand: Command = {
  name: 'models:download',
  summary: 'Fetch a .gguf from a URL into models/<role>/ and pin it',
  usage: DOWNLOAD_USAGE,
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        role: { type: 'string' },
        sha256: { type: 'string' },
      },
      allowPositionals: true,
    });
    if (values.help) return print(DOWNLOAD_USAGE);
    try {
      const root = harnessProjectRoot();
      const role = parseRole(values.role);
      const url = positionals[0];
      if (!url) throw new Error('missing <url>. Usage: harness.dev models:download <url> [--role] [--sha256]');
      const expectedSha = values.sha256?.trim().toLowerCase();

      const fileName = fileNameFromUrl(url);
      const relPath = `models/${role}/${fileName}`;
      const destDir = join(root, 'models', role);
      const dest = join(destDir, fileName);
      await mkdir(destDir, { recursive: true });

      if (!expectedSha) {
        process.stderr.write(
          'WARNING: a URL download is trusted by source, NOT catalog-digest-verified. ' +
            'Pass --sha256 <hex> to verify the bytes.\n',
        );
      }

      await streamToFile(url, dest, expectedSha);

      const size = (await stat(dest)).size;
      writeModelField(root, role, { path: `./${relPath}` });
      process.stdout.write(
        `downloaded ${role} model → ${relPath} (${formatBytes(size)})\n` +
          `  model.${role}.path = ./${relPath}${expectedSha ? '  [sha256 verified]' : '  [trusted by source]'}\n`,
      );
      return 0;
    } catch (err) {
      process.stderr.write(`harness.dev models:download: ${asMessage(err)}\n`);
      return 1;
    }
  },
};

// ── models:list ───────────────────────────────────────────────────────────────

const LIST_USAGE = [
  'harness.dev models:list — show catalog ids, the active pins, and installed files',
  '',
  'Usage:',
  '  npx harness.dev models:list',
].join('\n');

export const modelsListCommand: Command = {
  name: 'models:list',
  summary: 'Show catalog ids, active harness.yml pins, and installed files',
  usage: LIST_USAGE,
  async run(argv) {
    const { values } = parseArgs({ args: [...argv], options: { help: { type: 'boolean', short: 'h' } } });
    if (values.help) return print(LIST_USAGE);
    try {
      const root = harnessProjectRoot();
      const out: string[] = [];

      out.push('Catalog (fetched + digest-verified on first run — no API key):');
      for (const m of MODEL_CATALOG) {
        out.push(`  ${m.role.padEnd(9)} ${m.id.padEnd(24)} ${m.label}`);
      }

      out.push('', 'Active (harness.yml):');
      for (const role of ROLES) {
        const spec = readModelField(root, role);
        const shown =
          spec == null
            ? role === 'reranker'
              ? '(unset — auto-provisions the catalog default when an app needs it)'
              : '(unset)'
            : 'id' in spec
              ? `id: ${spec.id}`
              : `path: ${spec.path}`;
        out.push(`  ${role.padEnd(9)} ${shown}`);
      }

      out.push('', 'Installed files (models/<role>/):');
      let anyFile = false;
      for (const role of ROLES) {
        for (const f of ggufFiles(join(root, 'models', role))) {
          out.push(`  ${role}/${f}`);
          anyFile = true;
        }
      }
      if (!anyFile) out.push('  (none yet — fetched on first run, or add one with models:add/download)');

      process.stdout.write(`${out.join('\n')}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`harness.dev models:list: ${asMessage(err)}\n`);
      return 1;
    }
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function print(usage: string): number {
  process.stdout.write(`${usage}\n`);
  return 0;
}

/** Derive a `.gguf` filename from a download URL (query strings stripped). */
function fileNameFromUrl(url: string): string {
  let name = '';
  try {
    name = basename(new URL(url).pathname).trim();
  } catch {
    name = '';
  }
  if (!name) name = 'model';
  return name.endsWith('.gguf') ? name : `${name}.gguf`;
}

/**
 * Stream `url` → `dest`, hashing as it flows so a multi-GB weight never lands
 * in memory. When `expectedSha` is given, verify after the write and fail-closed
 * (delete + throw) on a mismatch. On any failure the partial file is removed.
 */
async function streamToFile(url: string, dest: string, expectedSha: string | undefined): Promise<void> {
  const res = await httpFetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch ${url} returned HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = expectedSha ? createHash('sha256') : null;
  const name = basename(dest);
  let got = 0;
  let lastPct = -1;

  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          got += chunk.length;
          hash?.update(chunk);
          if (total > 0) {
            const pct = Math.floor((100 * got) / total);
            if (pct !== lastPct) {
              lastPct = pct;
              process.stderr.write(`\rdownloading ${name} — ${pct}%   `);
            }
          }
          yield chunk;
        }
      },
      createWriteStream(dest),
    );
    process.stderr.write('\n');
  } catch (err) {
    await unlink(dest).catch(() => {});
    throw err;
  }

  if (hash) {
    const actual = hash.digest('hex');
    if (actual !== expectedSha) {
      await unlink(dest).catch(() => {});
      throw new Error(`sha256 mismatch — expected ${expectedSha}, got ${actual}. File deleted.`);
    }
  }
}

function ggufFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.gguf'));
  } catch {
    return [];
  }
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** All four `models:` verbs, in listing order. */
export const modelsCommands: readonly Command[] = [
  modelsUseCommand,
  modelsAddCommand,
  modelsDownloadCommand,
  modelsListCommand,
];
