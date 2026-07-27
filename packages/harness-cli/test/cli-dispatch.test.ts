import { describe, it, expect, vi, afterEach } from 'vitest';
import { main } from '../src/cli.js';
import { findCommand } from '../src/commands/index.js';

function captureStderr(): { output: () => string; restore: () => void } {
  let buf = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    buf += chunk.toString();
    return true;
  });
  return { output: () => buf, restore: () => spy.mockRestore() };
}
function captureStdout(): { restore: () => void } {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return { restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe('dispatcher — unknown command', () => {
  it('errors (exit 1) and suggests `new`, does NOT scaffold', async () => {
    const err = captureStderr();
    const code = await main(['approve']);
    err.restore();
    expect(code).toBe(1);
    expect(err.output()).toContain('unknown command "approve"');
    expect(err.output()).toContain('harness.dev new approve');
  });

  it('does not suggest `new` for a flag-like token', async () => {
    const err = captureStderr();
    const code = await main(['--frobnicate']);
    err.restore();
    expect(code).toBe(1);
    expect(err.output()).toContain('unknown command "--frobnicate"');
    expect(err.output()).not.toContain('new --frobnicate');
  });
});

describe('dispatcher — help + version', () => {
  it('bare invocation prints help (exit 0)', async () => {
    const out = captureStdout();
    const code = await main([]);
    out.restore();
    expect(code).toBe(0);
  });

  it('--help prints help (exit 0)', async () => {
    const out = captureStdout();
    const code = await main(['--help']);
    out.restore();
    expect(code).toBe(0);
  });

  it('--version prints the version (exit 0)', async () => {
    const out = captureStdout();
    const code = await main(['--version']);
    out.restore();
    expect(code).toBe(0);
  });
});

describe('findCommand', () => {
  it('resolves the `new` verb + named subcommands', () => {
    expect(findCommand('new')?.name).toBe('new');
    expect(findCommand('app:new')?.name).toBe('app:new');
    expect(findCommand('install')?.name).toBe('install');
  });

  it('returns undefined for retired/unknown tokens (so the dispatcher errors)', () => {
    // `create` and `app` were renamed — no backward-compat alias.
    expect(findCommand('create')).toBeUndefined();
    expect(findCommand('app')).toBeUndefined();
    expect(findCommand('approve')).toBeUndefined();
    expect(findCommand('bogus')).toBeUndefined();
  });
});
