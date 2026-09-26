/**
 * The install's wire: what the boot routes to the install, whole, and what it does not.
 */
import { describe, it, expect } from 'vitest';
import { isInstallCommand } from '../src/install-protocol';

describe('isInstallCommand: one of the install\'s three, whole', () => {
  it('accepts retry, quit, and a use_file that names its step and its path', () => {
    expect(isInstallCommand({ type: 'install:retry' })).toBe(true);
    expect(isInstallCommand({ type: 'install:quit' })).toBe(true);
    expect(isInstallCommand({ type: 'install:use_file', step: 'llm', path: '/weights/mine.gguf' })).toBe(true);
  });

  it('refuses a use_file missing either field — it would reach the install as a command it cannot act on', () => {
    expect(isInstallCommand({ type: 'install:use_file', step: 'llm' })).toBe(false);
    expect(isInstallCommand({ type: 'install:use_file', path: '/weights/mine.gguf' })).toBe(false);
    expect(isInstallCommand({ type: 'install:use_file', step: 4, path: '/weights/mine.gguf' })).toBe(false);
  });

  it('refuses anything else that says install: — the event, an invented verb — so it reaches the harness as the unknown command it is', () => {
    expect(isInstallCommand({ type: 'install:step', steps: [] })).toBe(false);
    expect(isInstallCommand({ type: 'install:pause' })).toBe(false);
    expect(isInstallCommand({ type: 'install:' })).toBe(false);
  });

  it('refuses what is not an object with a type at all', () => {
    expect(isInstallCommand('install:retry')).toBe(false);
    expect(isInstallCommand(null)).toBe(false);
    expect(isInstallCommand({})).toBe(false);
  });
});
