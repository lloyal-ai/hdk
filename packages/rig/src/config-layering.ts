/**
 * The layering a `defineConfig` table describes, run: `harness.yml` read and
 * validated loud, the rungs `cli > env > harness.json > harness.yml > default`
 * layered with provenance, the local file written back, and the Runner's
 * plumbing for a boot. Over the disk mechanics in `config-node` (atomic 0600
 * writes, the writer's version guard, the gitignore append, path resolution),
 * which are not repeated here.
 *
 * Two rungs, two tempers: the committed manifest is a deliberate deploy and a
 * typo in it fails the boot with the yml path and what the key takes; the
 * local overlay is machine-written and a hand edit it cannot take falls
 * through to the rung beneath. An empty string is a clear at every rung. The
 * `abilities` family layers for every app: committed entries, then the local
 * overlay whole-replacing a named ability, path-shaped values resolved.
 *
 * A block — the family a three-level key lives in, `model.vision` — is carried
 * by its presence: `vision: {}` in either file requests the service and says
 * nothing about its keys, and a default inside a block stands only once the
 * block does. Every top-level family the table declares is present.
 *
 * Node-only: import from `@lloyal-labs/rig/node`.
 *
 * @category Rig
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { CONFIG_VERSION, mergeConfig } from './config';
import type { ConfigKey, ConfigTable, ConfigOf, OriginOf, CliOf, YmlOf } from './config';
import type { BaseHarnessConfig, ConfigOriginValue, ConfigPatch, LoadedConfig, RunnerConfigOpts, SaveResult } from './runner';
import { rung } from './runner';
import {
  resolvePath,
  resolveAppConfigPaths,
  readJsonOverlay,
  readJsonForWrite,
  writeJsonAtomic,
  maybeAppendGitignore,
} from './config-node';

const JSON_NAME = 'harness.json';
const YML_NAME = 'harness.yml';

type Bag = Record<string, unknown>;

/** A family holds keys; a scalar — or an array — is one value, however deep the table goes. */
const isFamily = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether a rung carries a block: a mapping, or a bare key with nothing under it. */
const carriesBlock = (v: unknown): boolean => v === null || isFamily(v);

/** The block a key lives in — the family a three-level key sits under, `model.vision` — or nothing for a
 *  shallower key. As the key names it, or as the yml does. */
const blockOf = (dotted: string): string | undefined => {
  const segs = dotted.split('.');
  return segs.length >= 3 ? segs.slice(0, -1).join('.') : undefined;
};

/** Where the rungs are read from. */
export interface ConfigSource<T extends ConfigTable> {
  cli?: CliOf<T>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function getPath(bag: unknown, dotted: string): unknown {
  let node: unknown = bag;
  for (const seg of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Bag)[seg];
  }
  return node;
}

function setPath(bag: Bag, dotted: string, value: unknown): void {
  const segs = dotted.split('.');
  let node = bag;
  for (const seg of segs.slice(0, -1)) {
    const next = node[seg];
    if (next === null || typeof next !== 'object') node[seg] = {};
    node = node[seg] as Bag;
  }
  node[segs[segs.length - 1]] = value;
}

/** Absent, null and the empty string are all "nothing here": a clear. */
const present = (v: unknown): unknown => (v === undefined || v === null || v === '' ? undefined : v);

/** A value as typed or set: text is trimmed first, so a whitespace-only value is nothing here too. The one
 *  normalization, for deciding a block's presence and for accepting a key alike. */
const given = (raw: unknown): unknown => present(typeof raw === 'string' ? raw.trim() : raw);

/** Whether a present value is one the key takes. */
function takes(key: ConfigKey, v: unknown): boolean {
  if (key.integer && !(Number.isInteger(v) && (v as number) >= 1)) return false;
  if (key.oneOf && !(typeof v === 'string' && key.oneOf.includes(v))) return false;
  if (key.check && !key.check(v)) return false;
  return true;
}

/** What the key takes, said for a refusal. */
function expectation(key: ConfigKey): string {
  if (key.oneOf) {
    const v = key.oneOf;
    return `must be ${v.length > 1 ? `${v.slice(0, -1).join(', ')}, or ${v[v.length - 1]}` : v[0]}`;
  }
  if (key.integer) return 'must be a positive integer';
  return 'is not valid';
}

/** A rung's value, accepted or fallen through. The env rung arrives as text and is parsed for an integer key. A
 *  relative path resolves against `base`: the project for a value from its files or its default, the process for one
 *  typed at the cli or set in the environment. */
function accept(key: ConfigKey, raw: unknown, base: string, fromEnv = false): unknown {
  let v = given(raw);
  if (v === undefined) return undefined;
  if (fromEnv && key.integer) v = typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : undefined;
  if (v === undefined || !takes(key, v)) return undefined;
  return key.path && typeof v === 'string' ? resolvePath(v, base) : v;
}

/** Every committed value a key cannot take, loud, in yml order. */
function validateYml(table: ConfigTable, yml: unknown): void {
  for (const key of Object.values(table)) {
    if (!key.yml) continue;
    const v = present(getPath(yml, key.yml));
    if (v !== undefined && !takes(key, v)) {
      throw new Error(`${YML_NAME}: ${key.yml} ${expectation(key)} (got ${JSON.stringify(v)})`);
    }
  }
}

/**
 * Read and validate `harness.yml`. Throws one line on a missing, unparseable or
 * invalid file — the boot prints it and exits: a bad manifest fails before any
 * model fetch.
 *
 * @category Rig
 */
export function loadYml<T extends ConfigTable>(table: T, cwd: string = process.cwd()): YmlOf<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, YML_NAME), 'utf8');
  } catch {
    throw new Error(`${YML_NAME} not found — run from your harness project root.`);
  }
  let yml: unknown;
  try {
    yml = parse(raw) ?? {};
  } catch (err) {
    throw new Error(`${YML_NAME} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (yml === null || typeof yml !== 'object' || Array.isArray(yml)) {
    throw new Error(`${YML_NAME} must be a mapping at the top level`);
  }
  validateYml(table, yml);
  return yml as YmlOf<T>;
}

/**
 * Layer the rungs for every declared key, computing provenance as the layering
 * runs, so nothing reports a source it did not use. The `abilities` family
 * follows: committed entries, then the local overlay whole-replacing a name.
 *
 * @category Rig
 */
export function loadConfig<T extends ConfigTable>(
  table: T,
  yml: YmlOf<T>,
  source: ConfigSource<T> = {},
): LoadedConfig<ConfigOf<T>, OriginOf<T>> {
  const cwd = source.cwd ?? process.cwd();
  const env = source.env ?? process.env;
  const cli = (source.cli ?? {}) as Bag;
  const resolvedPath = path.resolve(cwd, JSON_NAME);
  const local = readJsonOverlay<Bag>(resolvedPath);

  const config: Bag = { version: CONFIG_VERSION, sources: {}, abilities: {}, model: {} };
  for (const name of Object.keys(table)) if (name.includes('.')) config[name.split('.')[0]] ??= {};

  // A block is requested by ANY rung naming it, decided before a single key is read: a file naming the block
  // (a mapping, or a bare key), or a cli / env value for a key of it. A default alone never does. A scalar where
  // a block belongs is a value the key cannot take — loud from the committed rung, dropped from the local one.
  const blocks = new Set<string>();
  for (const [name, key] of Object.entries(table)) {
    const block = blockOf(name);
    if (!block) continue;
    const ymlBlock = key.yml && blockOf(key.yml);
    if (ymlBlock) {
      const committed = getPath(yml, ymlBlock);
      if (committed !== undefined && !carriesBlock(committed)) {
        throw new Error(`${YML_NAME}: ${ymlBlock} must be a block of keys (got ${JSON.stringify(committed)})`);
      }
      if (carriesBlock(committed)) blocks.add(block);
    }
    if (carriesBlock(getPath(local, block))) blocks.add(block);
    if (key.cli && given(cli[key.cli]) !== undefined) blocks.add(block);
    if (key.env && given(env[key.env]) !== undefined) blocks.add(block);
  }
  for (const block of blocks) setPath(config, block, {});

  const origin: Record<string, ConfigOriginValue> = {};
  for (const [name, key] of Object.entries(table)) {
    const c = key.cli ? accept(key, cli[key.cli], process.cwd()) : undefined;
    const e = key.env ? accept(key, env[key.env], process.cwd(), true) : undefined;
    const l = accept(key, getPath(local, name), cwd);
    const y = key.yml ? accept(key, getPath(yml, key.yml), cwd) : undefined;
    const supplied = c ?? e ?? l ?? y;
    origin[name] = rung(c, e, l, y);
    const block = blockOf(name);
    const inAbsentBlock = block !== undefined && getPath(config, block) === undefined;
    const chosen = supplied ?? (inAbsentBlock ? undefined : key.default);
    if (chosen !== undefined) {
      setPath(config, name, key.path && typeof chosen === 'string' ? resolvePath(chosen, cwd) : chosen);
    }
  }

  const abilities: Record<string, Bag> = {};
  for (const [name, cfg] of Object.entries((yml as { abilities?: Record<string, Bag> }).abilities ?? {})) {
    abilities[name] = resolveAppConfigPaths(cfg, cwd);
  }
  for (const [name, cfg] of Object.entries((local?.abilities as Record<string, Bag> | undefined) ?? {})) {
    abilities[name] = resolveAppConfigPaths(cfg, cwd);
  }
  config.abilities = abilities;

  return { config: config as ConfigOf<T>, origin: origin as OriginOf<T>, path: resolvedPath, loadedFromFile: local !== null };
}

/**
 * Write a patch into `harness.json`, atomically, 0600. The patch merges over
 * the file by the table (`mergeConfig`): into each family it names, however
 * deep, and replacing anything else whole; a key set to `""` is cleared; a
 * named ability is whole-replaced and the others kept. A file the writer
 * cannot understand is never rebuilt over (`readJsonForWrite`).
 *
 * @category Rig
 */
export function saveLocalConfig<C>(table: ConfigTable, patch: ConfigPatch<C>, cwd: string = process.cwd()): SaveResult {
  const resolvedPath = path.resolve(cwd, JSON_NAME);
  const current = { sources: {}, abilities: {}, ...(readJsonForWrite<Bag>(resolvedPath, JSON_NAME) ?? {}) } as BaseHarnessConfig;
  writeJsonAtomic(resolvedPath, mergeConfig(table, current, patch as ConfigPatch<BaseHarnessConfig>));
  return { path: resolvedPath, gitignored: maybeAppendGitignore(resolvedPath), skipped: [] };
}

/**
 * The layered config and the Runner's plumbing for it, in one value a boot
 * spreads into `makeEdgeRunner`/`makeServedRunner`: provenance by the table's
 * own keys, saves that persist to `harness.json` and re-layer value and
 * provenance together, `session` marks by the same keys, and the model block
 * frozen at boot — it describes the running residency, which a save cannot change.
 *
 * @category Rig
 */
export function runnerConfig<T extends ConfigTable>(
  table: T,
  yml: YmlOf<T>,
  source: ConfigSource<T> = {},
): LoadedConfig<ConfigOf<T>, OriginOf<T>> & RunnerConfigOpts<ConfigOf<T>, OriginOf<T>> {
  const loaded = loadConfig(table, yml, source);
  const keys = Object.keys(table);
  return {
    ...loaded,
    table,
    persist: (patch) => {
      const saved = saveLocalConfig(table, patch, source.cwd);
      const relayered = loadConfig(table, yml, source);
      return { ...saved, config: relayered.config, origin: relayered.origin };
    },
    sessionOriginMap: Object.fromEntries(keys.map((k) => [k, k])) as Record<string, keyof OriginOf<T> & string>,
    frozen: { config: ['model'], origin: keys.filter((k) => k.startsWith('model.')) },
  };
}
