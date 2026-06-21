/**
 * Publish-time "attention surface" extraction.
 *
 * At `harness.dev publish` (a TRUSTED publisher-machine context) we serialize
 * everything the app injects into the model's context — the per-spawn skill
 * prose, every tool's name + description + parameter schema, `useWhen`, and the
 * config schema — into `attention-surface.json`, which the publish command
 * writes INTO the npm tarball. Because the worker signs the tarball bytes at
 * approval, this artifact is covered by the same Ed25519 signature: a reviewer
 * and `harness.dev install` can verify exactly what enters the model WITHOUT
 * executing untrusted code.
 *
 * Tool descriptions + parameter schemas live in compiled `Tool` instances, so
 * the only way to read them is to CONSTRUCT the app. We do that in an ISOLATED
 * subprocess (`node -e`, cwd = the app dir so its own deps resolve) under a
 * describe harness that seeds mock Effection contexts — never in the CLI's own
 * process. This keeps the consumer-facing CLI dependency-free, sandboxes
 * arbitrary construction code behind a 30s timeout, and degrades LOUDLY to
 * app.json tool NAMES if construction throws / times out / the app is ESM-only.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface AttentionSurfaceTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's args, or null if absent. */
  parameters: unknown | null;
  protected: boolean;
}

export interface AttentionSurface {
  /** Forward-compat seam (number, not a literal) so install tolerates bumps. */
  schemaVersion: number;
  protocol: { name: string; useWhen: string; tools: string[] };
  /** Raw skill.eta template — the per-spawn system prompt. NEVER pre-rendered. */
  skill: string;
  configSchema?: unknown;
  tools: AttentionSurfaceTool[];
  /** True when tool descriptions/params could not be extracted (names only). */
  degraded?: boolean;
}

export interface DescribeAppJson {
  name: string;
  appProtocolVersion?: string;
  protocol?: { name?: string; useWhen?: string; tools?: string[] };
  configSchema?: { required?: unknown } & Record<string, unknown>;
}

export interface DescribePackageJson {
  name: string;
  version: string;
  main?: string;
}

const DESCRIBE_TIMEOUT_MS = 30_000;

/**
 * The describe subprocess body. Runs in the APP's directory so `require`
 * resolves the app's own `effection` + `@lloyal-labs/lloyal-agents`. Reads the
 * entry path + required-config keys from env (robust vs `-e` argv quirks).
 */
const DESCRIBE_SCRIPT = `(async () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const tmpDirs = [];
  try {
    const entry = process.env.HARNESS_DESCRIBE_ENTRY;
    const required = JSON.parse(process.env.HARNESS_DESCRIBE_REQUIRED || '[]');
    const { run } = require('effection');
    const { RerankerCtx, AppConfigStoreCtx } = require('@lloyal-labs/lloyal-agents');
    const mod = require(entry);
    const key = Object.keys(mod).find((k) => /^create[A-Za-z0-9]*App$/.test(k) && typeof mod[k] === 'function');
    if (!key) throw new Error('no create*App factory export in ' + entry);
    const factory = mod[key];
    const synth = {};
    for (const k of required) {
      if (/path|dir|file|root/i.test(k)) {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-describe-'));
        tmpDirs.push(d);
        // Seed a placeholder doc so resource-loading factories (e.g. corpus)
        // construct over a NON-empty dir instead of throwing "no files matched".
        try { fs.writeFileSync(path.join(d, '_describe.md'), '# describe placeholder'); } catch {}
        synth[k] = d;
      } else {
        synth[k] = 'describe-placeholder';
      }
    }
    // Mock reranker — only construction needs it to exist (tokenizeChunks is
    // promise-returning per the corpus call site; the rest are never hit at build).
    const reranker = {
      tokenizeChunks: async () => {},
      rank: async () => [],
      score: async () => 0,
      rerank: async (_q, items) => items,
    };
    const cfgStore = { *get() { return synth; }, *set() {}, *clear() {} };
    const app = await run(function* () {
      yield* RerankerCtx.set(reranker);
      yield* AppConfigStoreCtx.set(cfgStore);
      return yield* factory();
    });
    const tools = (app.tools || []).map((t) => ({
      name: String(t.name),
      description: typeof t.description === 'string' ? t.description : '',
      parameters: t.parameters == null ? null : t.parameters,
      protected: t.protected === true,
    }));
    process.stdout.write(JSON.stringify({ tools }));
  } catch (e) {
    process.stderr.write(String((e && e.stack) || e));
    process.exitCode = 3;
  } finally {
    // Reap the synthetic config dirs created above — else every describe run
    // (publish, tests) leaks a harness-describe-* dir per path-like config key.
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
  // Do NOT call process.exit() here. The parent reads stdout as a PIPE, so the
  // write is async — process.exit() can terminate before a large JSON payload
  // finishes flushing, truncating it so the parent mis-reads a successful
  // describe as "unparseable output" and degrades to names-only. Let Node exit
  // naturally once the event loop drains (stdout/stderr flush first);
  // process.exitCode (set to 3 on failure above) is honored. A genuine hang is
  // bounded by the parent spawn's \`timeout\`.
})();`;

function requiredConfigKeys(configSchema: DescribeAppJson['configSchema']): string[] {
  const req = configSchema?.required;
  return Array.isArray(req) ? req.filter((k): k is string => typeof k === 'string') : [];
}

function coerceTool(t: unknown): AttentionSurfaceTool | null {
  if (typeof t !== 'object' || t === null) return null;
  const o = t as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length === 0) return null;
  return {
    name: o.name,
    description: typeof o.description === 'string' ? o.description : '',
    parameters: o.parameters ?? null,
    protected: o.protected === true,
  };
}

/**
 * Construct the app in an isolated subprocess and read its tool schemas.
 * Returns null on ANY failure (logged) so the caller falls back to names.
 */
function describeTools(
  appDir: string,
  mainRel: string,
  required: string[],
  appName: string,
): Promise<AttentionSurfaceTool[] | null> {
  return new Promise((resolvePromise) => {
    const entry = resolve(appDir, mainRel);
    // Strip NODE_OPTIONS so a parent-process loader (e.g. a test runner's, or a
    // publisher's wrapper) isn't inherited by the bare `node -e` describe child.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HARNESS_DESCRIBE_ENTRY: entry,
      HARNESS_DESCRIBE_REQUIRED: JSON.stringify(required),
    };
    delete childEnv.NODE_OPTIONS;
    const proc = spawn(process.execPath, ['-e', DESCRIBE_SCRIPT], {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DESCRIBE_TIMEOUT_MS,
      env: childEnv,
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf-8')));
    proc.stderr.on('data', (c: Buffer) => (err += c.toString('utf-8')));
    const fallback = (why: string) => {
      process.stderr.write(
        `harness.dev publish: WARNING — could not construct "${appName}" to read tool ` +
          `descriptions/parameters (${why.trim().split('\n')[0] || 'unknown'}). ` +
          `Falling back to tool NAMES only from app.json. The attention surface for ` +
          `this version will omit tool descriptions + parameter schemas.\n`,
      );
      resolvePromise(null);
    };
    proc.on('error', (e) => fallback(String((e as Error).message)));
    proc.on('close', (code, signal) => {
      // A signal kill (e.g. the `timeout` option firing SIGTERM) reports
      // code===null + a non-null signal; surface the signal so a timeout reads
      // as a kill, not the unhelpful "describe exited null".
      if (code !== 0)
        return fallback(err || (signal ? `describe killed by ${signal}` : `describe exited ${code}`));
      try {
        const parsed = JSON.parse(out) as { tools?: unknown };
        const tools = Array.isArray(parsed.tools)
          ? parsed.tools.map(coerceTool).filter((t): t is AttentionSurfaceTool => t !== null)
          : [];
        resolvePromise(tools);
      } catch {
        fallback('describe produced unparseable output');
      }
    });
  });
}

/**
 * Build the full attention surface for an app. `protocol` + `configSchema` come
 * from app.json; `skill` is the raw skill.eta file; tool schemas come from the
 * describe subprocess (with a names-only fallback).
 */
export async function buildAttentionSurface(
  appDir: string,
  appJson: DescribeAppJson,
  packageJson: DescribePackageJson,
): Promise<AttentionSurface> {
  const protocol = {
    name: appJson.protocol?.name ?? appJson.name,
    useWhen: appJson.protocol?.useWhen ?? '',
    tools: Array.isArray(appJson.protocol?.tools)
      ? appJson.protocol!.tools!.filter((t): t is string => typeof t === 'string')
      : [],
  };

  let skill = '';
  try {
    skill = await readFile(join(appDir, 'skill.eta'), 'utf-8');
  } catch {
    // Apps without a skill.eta are valid (rare) — leave skill empty.
  }

  const described = await describeTools(
    appDir,
    packageJson.main ?? 'dist/index.js',
    requiredConfigKeys(appJson.configSchema),
    appJson.name,
  );

  const degraded = described === null;
  const tools: AttentionSurfaceTool[] = described ?? protocol.tools.map((name) => ({
    name,
    description: '',
    parameters: null,
    protected: false,
  }));

  const surface: AttentionSurface = { schemaVersion: 1, protocol, skill, tools };
  if (appJson.configSchema !== undefined) surface.configSchema = appJson.configSchema;
  if (degraded) surface.degraded = true;
  return surface;
}
