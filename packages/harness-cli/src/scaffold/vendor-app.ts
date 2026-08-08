/**
 * Verify a signed HDK app and materialize it as a LOCAL `file:` tarball
 * dependency — the shared primitive behind `harness.dev install` (add-on apps)
 * and `harness.dev new` (a template's default app).
 *
 * **Why not `npm install <url>`.** npm 12 (default since 2026) refuses to
 * resolve a dependency from a remote URL/HTTPS tarball unless `--allow-remote`
 * is passed — the supply-chain hardening that followed the PhantomRaven RDD
 * campaign. Our whole app channel is "HTTPS tarballs from apps.lloyal.ai", so a
 * raw `npm install <tarballUrl>` is blocked. Instead the CLI does the fetch +
 * **Ed25519 verify** itself, writes the verified bytes into the project's
 * `vendor/` dir, and points `package.json` at them with a `file:` spec. npm then
 * only ever installs a LOCAL dependency — out of scope of npm 12's remote block
 * (`--allow-file`/`--allow-directory` keep permissive defaults) — and `npm ci`
 * reproduces it offline from the committed tarball. The Ed25519 signature is the
 * sole trust gate; npm's transport trust never enters the picture.
 *
 * The signed manifest sidecar is written next to the tarball so the bytes stay
 * re-verifiable offline (the manifest carries the signature + publisherKeyId,
 * which the catalog version entry does not).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fetchAndVerifyCatalog,
  resolveAppVersion,
  fetchAndVerifyManifest,
  verifyBundle,
  sha512Integrity,
  BundleVerificationError,
  type AppBundleManifest,
} from '../verify.js';
import { readTarEntry, isGzipReadable } from '../tar-read.js';
import type { AttentionSurface } from '../describe.js';
import { httpFetch } from '../http.js';

/**
 * Spec grammar: `<publisher>/<name>[@<semver>]` (post-W) or back-compat
 * `<name>[@<semver>]` (lloyal-internal pre-W entries, which never reached
 * external publish). Both segments of the scoped form match the app/handle
 * grammar `[a-z][a-z0-9_-]{1,63}`.
 */
export const SCOPED_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}\/[a-z][a-z0-9_-]{1,63}$/;
export const UNSCOPED_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

export interface AppSpec {
  /** Catalog identifier — `<publisher>/<name>` (or a bare pre-W `<name>`). */
  name: string;
  /** Optional semver range; `undefined` selects the highest published version. */
  semver: string | undefined;
}

export class InvalidAppSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAppSpecError';
  }
}

/**
 * Parse + validate `<publisher>/<name>[@<semver>]`. Scoped names contain `/`
 * but never `@`, so the first `@` (if any) is unambiguously the semver
 * delimiter. Throws {@link InvalidAppSpecError} on a malformed name.
 */
export function parseAppSpec(spec: string): AppSpec {
  const atIdx = spec.indexOf('@');
  const name = atIdx === -1 ? spec : spec.slice(0, atIdx);
  const semver = atIdx === -1 ? undefined : spec.slice(atIdx + 1);
  if (!SCOPED_NAME_PATTERN.test(name) && !UNSCOPED_NAME_PATTERN.test(name)) {
    throw new InvalidAppSpecError(
      `invalid app name "${name}" — expected \`<publisher>/<short-name>\` ` +
        '(e.g., `lloyal/web`, `acme/jira`).',
    );
  }
  return { name, semver };
}

/**
 * Flatten a scoped catalog name like `lloyal/web` to `lloyal__web` for use in a
 * filesystem path. Mirrors the R2 channel encoding the Worker writes on approval.
 */
export function flatEncodeScopedName(name: string): string {
  return name.replace('/', '__');
}

export interface VendoredApp {
  /** The catalog identifier that was vendored (`<publisher>/<name>`). */
  name: string;
  /** npm package name — the `import` symbol + the `package.json` dep key. */
  importName: string;
  /** Resolved version. */
  version: string;
  /** Project-relative, forward-slash `file:` target (e.g. `vendor/lloyal__web-1.0.0.tgz`). */
  vendorRelPath: string;
  /** `sha512-<base64>` over the verified tarball bytes. */
  integrity: string;
}

export interface VendorOptions {
  /**
   * Print the app's attention-surface disclosure (what it injects into the
   * model's context) to stdout. Default `true` for the explicit `install`
   * command; the scaffolder passes `false` to keep `new` output terse.
   */
  disclose?: boolean;
}

/**
 * Fetch → Ed25519-verify → vendor a signed app into `<projectDir>/vendor/` and
 * point `package.json` at it with a `file:` dependency. FATAL on any verify or
 * write failure — the vendored bytes become the source of truth, so there is no
 * silent fallback to a remote fetch. Returns the resolved coordinates.
 *
 * Mirrors `harness.dev install`'s verify chain step-for-step; the ONLY
 * difference from the old flow is the final materialization (local `file:` dep
 * instead of `npm install <remote-url>`).
 */
export async function verifyAndVendorApp(
  projectDir: string,
  spec: AppSpec,
  opts: VendorOptions = {},
): Promise<VendoredApp> {
  // 1-2. Catalog → version entry (Ed25519-verified catalog; pure resolve).
  const catalog = await fetchAndVerifyCatalog();
  const entry = resolveAppVersion(catalog, spec.name, { semver: spec.semver });

  // 3. Manifest fetch + cross-check (name/version/sizeBytes vs the catalog).
  const { manifest, trustKey } = await fetchAndVerifyManifest(entry, spec.name);

  // 4. Tarball fetch + Ed25519 verify over the raw bytes.
  const response = await httpFetch(entry.tarballUrl);
  if (!response.ok) {
    throw new BundleVerificationError(
      `Tarball fetch from ${entry.tarballUrl} returned HTTP ${response.status} ${response.statusText}.`,
    );
  }
  const tarball = new Uint8Array(await response.arrayBuffer());
  if (tarball.byteLength !== manifest.sizeBytes) {
    throw new BundleVerificationError(
      `Tarball size ${tarball.byteLength} does not match manifest.sizeBytes ${manifest.sizeBytes}.`,
    );
  }
  const ok = await verifyBundle(tarball, manifest.signature, trustKey);
  if (!ok) {
    throw new BundleVerificationError(
      `Ed25519 signature verification failed for ${spec.name}@${manifest.version} ` +
        `(publisherKeyId="${manifest.publisherKeyId}").`,
    );
  }

  // 5. Integrity cross-check: the sha512 we compute over the received bytes must
  // equal the signed manifest.integrity. The Ed25519 signature is the real trust
  // gate; this guards against a signing-pipeline bug emitting an integrity that
  // doesn't match what was signed.
  const integrity = await sha512Integrity(tarball);
  if (manifest.integrity !== integrity) {
    throw new BundleVerificationError(
      `manifest integrity ${manifest.integrity} does not match sha512 of received ` +
        `tarball bytes ${integrity}. This indicates a signing-pipeline bug — file an ` +
        `issue at https://github.com/lloyal-ai/hdk.`,
    );
  }

  // 5b. Best-effort disclosure of what the app injects into the model's context,
  // read from the ALREADY-VERIFIED bytes. Never blocks the vendor.
  if (opts.disclose !== false) {
    try {
      await renderAttentionSurface(tarball, spec.name);
    } catch {
      // disclosure is advisory; a parse/read failure must not fail the install
    }
  }

  // 6. Write the verified tarball + its signed manifest sidecar into vendor/.
  // The sidecar keeps the bytes re-verifiable offline (signature + keyId live in
  // the manifest, not in the catalog version entry).
  const base = `${flatEncodeScopedName(spec.name)}-${manifest.version}`;
  const vendorRelPath = `vendor/${base}.tgz`;
  const vendorDir = join(projectDir, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  await writeFile(join(vendorDir, `${base}.tgz`), tarball);
  await writeFile(
    join(vendorDir, `${base}.manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // 7. Point package.json at the local tarball (npm 12 installs `file:` deps
  // without --allow-remote; `npm ci` reproduces it offline from the committed
  // tarball).
  await setFileDependency(projectDir, entry.importName, vendorRelPath);

  return {
    name: spec.name,
    importName: entry.importName,
    version: manifest.version,
    vendorRelPath,
    integrity,
  };
}

/**
 * Set `dependencies[importName] = "file:<relPath>"` in `<projectDir>/package.json`,
 * preserving the rest of the file (parse → merge → 2-space re-stringify). Throws
 * if there is no `package.json` — vendoring only makes sense inside a project.
 */
async function setFileDependency(
  projectDir: string,
  importName: string,
  vendorRelPath: string,
): Promise<void> {
  const pkgPath = join(projectDir, 'package.json');
  let raw: string;
  try {
    raw = await readFile(pkgPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `no package.json in ${projectDir} — run this inside a harness project.`,
      );
    }
    throw err;
  }
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [importName]: `file:${vendorRelPath}` };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Print the app's attention surface — exactly what it injects into the model's
 * context — read from the Ed25519-verified tarball bytes. Best-effort: a parse
 * failure or a pre-feature app degrades to a one-line note.
 */
export async function renderAttentionSurface(tarball: Uint8Array, name: string): Promise<void> {
  const raw = await readTarEntry(tarball, 'package/attention-surface.json');
  if (raw === null) {
    // null = absent OR unreadable tarball. The bytes are Ed25519-verified, so
    // corruption is near-impossible; the real residual case is a package whose
    // decompressed size exceeds the inspect cap. Say which, honestly.
    const note = isGzipReadable(tarball)
      ? `${name} ships no attention-surface.json (published before context disclosure).`
      : `${name}'s package could not be read to disclose its attention surface (it exceeds the inspect cap or is corrupt).`;
    process.stdout.write(`\n  note: ${note}\n`);
    return;
  }
  let s: AttentionSurface;
  try {
    s = JSON.parse(raw) as AttentionSurface;
  } catch {
    process.stdout.write(`\n  note: ${name}'s attention surface could not be parsed.\n`);
    return;
  }
  process.stdout.write(formatAttentionSurface(s, name));
}

/**
 * Build the human-readable attention-surface disclosure. PURE + TOTAL: the input
 * is signed-for-authenticity but NOT shape-validated publisher JSON, so every
 * field is coerced/guarded — a malformed `tools`/`skill`/`configSchema` degrades
 * just that line, never throws. Exported for unit testing of the malformed-input
 * paths.
 */
export function formatAttentionSurface(s: AttentionSurface, name: string): string {
  const lines: string[] = [`\nWhat ${name} adds to your model's context:`];
  if (typeof s.protocol?.name === 'string') lines.push(`  protocol:  ${s.protocol.name}`);
  if (typeof s.protocol?.useWhen === 'string') lines.push(`  use when:  ${s.protocol.useWhen}`);

  const tools = (Array.isArray(s.tools) ? s.tools : []).filter(
    (t): t is NonNullable<typeof t> => !!t && typeof t === 'object',
  );
  lines.push(`\n  Tools (${tools.length}):`);
  for (const t of tools) {
    const nm = typeof t.name === 'string' && t.name ? t.name : '(unnamed)';
    // `protected` means the tool requires a session grant (authGuard/GrantStore)
    // to be callable — it is about consent, NOT about whether the tool mutates.
    const tag = t.protected === true ? '  [needs grant]' : '';
    const desc = typeof t.description === 'string' && t.description ? ` — ${t.description}` : '';
    lines.push(`    • ${nm}${desc}${tag}`);
  }
  if (s.degraded) lines.push('    (tool descriptions unavailable for this version)');

  const props = (s.configSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const keys = props && typeof props === 'object' ? Object.keys(props) : [];
  if (keys.length) {
    lines.push('\n  Config it reads:');
    for (const k of keys) {
      const p = props![k] as { type?: unknown; 'x-secret'?: unknown } | null | undefined;
      const secret = p && typeof p === 'object' && p['x-secret'] ? ', secret' : '';
      const ty = p && typeof p === 'object' && typeof p.type === 'string' ? p.type : 'value';
      lines.push(`    • ${k} (${ty}${secret})`);
    }
  }

  if (typeof s.skill === 'string' && s.skill) {
    const all = s.skill.split('\n');
    const shown = all.slice(0, 10);
    lines.push('\n  System-prompt skill (per turn):');
    for (const l of shown) lines.push(`    | ${l}`);
    if (all.length > shown.length) lines.push(`    | … (${all.length - shown.length} more lines)`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export type { AppBundleManifest };
