/**
 * `harness.dev new` must emit a project that typechecks and boots — which means
 * the template's default AgentApps must be vendored, because each template's
 * `harness/harness.ts` imports them at the top level. The regression this guards
 * is 0.7.1's: vendoring was gated on `process.stdout.isTTY`, so every piped /
 * CI / scripted scaffold produced a project failing `tsc` with TS2307 and
 * `npm start` with ERR_MODULE_NOT_FOUND.
 *
 * The vendor step is mocked — these assert the CONTROL FLOW around it (when it
 * runs, with what, and what gets reported when it doesn't), never the network.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VendoredApp } from '../src/scaffold/vendor-app.js';

const vendorMock = vi.hoisted(() => vi.fn());

vi.mock('../src/scaffold/vendor-app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scaffold/vendor-app.js')>();
  return { ...actual, verifyAndVendorApp: vendorMock };
});

const { newCommand, DEFAULT_APPS } = await import('../src/commands/new.js');
const { printNextSteps } = await import('../src/scaffold/post-scaffold.js');

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

const created: string[] = [];
let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vendorMock.mockReset();
  vendorMock.mockImplementation(
    async (_dir: string, spec: { name: string }): Promise<VendoredApp> => ({
      name: spec.name,
      importName: `@lloyal-labs/${spec.name.split('/')[1]}-app`,
      version: '1.3.0',
      vendorRelPath: `vendor/${spec.name.replace('/', '__')}-1.3.0.tgz`,
      integrity: 'sha512-stub',
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  while (created.length) rmSync(created.pop() as string, { recursive: true, force: true });
});

/** Run `new` non-interactively into a throwaway parent dir. */
async function scaffold(name: string, extra: string[] = []): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), 'new-apps-'));
  created.push(parent);
  const code = await newCommand.run([name, '--dir', parent, '--targets', 'cli', ...extra]);
  expect(code).toBe(0);
  return join(parent, name);
}

function marker(dir: string): { template: string; targets: string[]; apps: string[] } {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).harnessdev;
}

/** Specs passed to the (mocked) vendor step, in call order. */
function vendoredSpecs(): string[] {
  return vendorMock.mock.calls.map((c) => (c[1] as { name: string; semver?: string }).name);
}

describe('new — default apps are vendored regardless of TTY / --skip-install', () => {
  it('research: vendors BOTH default apps on the non-interactive (non-TTY) path', async () => {
    // This is the 0.7.1 bug verbatim: no TTY, so nothing was vendored.
    const dir = await scaffold('r1', ['--template', 'research']);
    expect(vendoredSpecs()).toEqual(['lloyal/corpus', 'lloyal/web']);
    // The pin travels with the spec — the vendored version must be reproducible.
    expect(vendorMock.mock.calls[0][1]).toMatchObject({ name: 'lloyal/corpus', semver: '1.3.0' });
    expect(vendorMock.mock.calls[1][1]).toMatchObject({ name: 'lloyal/web', semver: '1.3.0' });
    expect(marker(dir).apps).toEqual(DEFAULT_APPS.research);
    // Nothing pending → the panel is the plain "ready" one.
    expect(stdout).toContain('is ready.');
    expect(stdout).not.toContain('Required');
  });

  it('basic: vendors its one default app', async () => {
    await scaffold('b1', ['--template', 'basic']);
    expect(vendoredSpecs()).toEqual(['lloyal/wikipedia']);
  });

  it('--skip-install does NOT suppress vendoring (it only skips `npm install`)', async () => {
    await scaffold('r2', ['--template', 'research', '--skip-install']);
    expect(vendoredSpecs()).toEqual(['lloyal/corpus', 'lloyal/web']);
  });

  it('--skip-apps is the ONLY opt-out, and says the project will not run', async () => {
    const dir = await scaffold('r3', ['--template', 'research', '--skip-apps']);
    expect(vendorMock).not.toHaveBeenCalled();
    // The specs are still recorded, so `bin/run.js` can name them at boot.
    expect(marker(dir).apps).toEqual(DEFAULT_APPS.research);
    expect(stdout).toContain('npx harness.dev install lloyal/corpus@1.3.0');
    expect(stdout).toContain('npx harness.dev install lloyal/web@1.3.0');
    expect(stdout).toContain('will not typecheck or start');
  });

  it('a fetch failure warns and reports the spec as pending, but still scaffolds', async () => {
    vendorMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND apps.lloyal.ai'));
    const dir = await scaffold('r4', ['--template', 'research']);
    expect(stderr).toContain('could not fetch default app lloyal/corpus@1.3.0');
    expect(stdout).toContain('npx harness.dev install lloyal/corpus@1.3.0');
    expect(marker(dir).template).toBe('research'); // the scaffold itself survived
  });
});

describe('printNextSteps — pending apps come BEFORE the run commands', () => {
  it('orders the required install above "Run it" and drops the bare npm install', () => {
    printNextSteps({
      name: 'proj',
      targets: ['cli'],
      installed: false,
      pendingApps: ['lloyal/corpus@1.3.0'],
    });
    const required = stdout.indexOf('npx harness.dev install lloyal/corpus@1.3.0');
    const runIt = stdout.indexOf('Run it');
    expect(required).toBeGreaterThan(-1);
    expect(runIt).toBeGreaterThan(-1);
    // The 0.7.1 panel printed these the other way round, so following it top-to-
    // bottom ran a project that could not start.
    expect(required).toBeLessThan(runIt);
    // `harness.dev install` runs npm install itself — a second bare `npm install`
    // step above it would just be noise.
    expect(stdout).not.toMatch(/^ {2}npm install$/m);
  });

  it('with nothing pending, keeps the plain ready panel', () => {
    printNextSteps({ name: 'proj', targets: ['cli'], installed: false, pendingApps: [] });
    expect(stdout).toContain('proj is ready.');
    expect(stdout).toMatch(/^ {2}(\x1b\[2m)?npm install/m);
  });
});

describe('DEFAULT_APPS covers what each template actually imports', () => {
  it.each(['basic', 'research'] as const)(
    '%s: one default app spec per `*-app` package harness.ts imports',
    (template) => {
      const src = readFileSync(join(TEMPLATES, template, 'harness', 'harness.ts'), 'utf8');
      const imported = [...src.matchAll(/from "(@[\w-]+\/[\w-]+-app)"/g)].map((m) => m[1]);
      expect(imported.length).toBeGreaterThan(0);
      // Not a name-for-name check (the npm name comes from the signed catalog at
      // install time) — a count check, which is what catches "a new app was added
      // to the template but never to DEFAULT_APPS".
      expect(DEFAULT_APPS[template]).toHaveLength(imported.length);
    },
  );

  it('every spec is version-pinned, so a scaffold is reproducible', () => {
    for (const specs of Object.values(DEFAULT_APPS)) {
      for (const spec of specs) expect(spec).toMatch(/^[a-z][\w-]*\/[a-z][\w-]*@\d+\.\d+\.\d+$/);
    }
  });
});
