/**
 * A boot failure in an installed application: the reader is told, and the process stops.
 *
 * The case that matters is a broken installation — a manifest that cannot be seeded, a read-only
 * folder — where the window never opens. Without this the app dies with nothing on screen and its
 * reason in a log that an app launched from the Finder does not have.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const shown: { title: string; body: string }[] = [];
const exited: number[] = [];
vi.mock('electron', () => ({
  app: { getName: () => 'Fieldnote', exit: (code: number) => { exited.push(code); } },
  dialog: { showErrorBox: (title: string, body: string) => { shown.push({ title, body }); } },
}));

const { cannotRun } = await import('../src/cannot-run');
const { SeedFailed } = await import('../src/placement');

afterEach(() => { shown.length = 0; exited.length = 0; vi.restoreAllMocks(); });

/** The stack belongs on stderr for a developer; the suite does not need to read it. */
const quiet = (): void => { vi.spyOn(console, 'error').mockImplementation(() => {}); };

describe('cannotRun', () => {
  it('shows why, under a title naming the application', () => {
    quiet();
    cannotRun(new SeedFailed('/app/harness.yml', '/data/harness.yml', new Error('EROFS: read-only file system')));
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Fieldnote cannot start');
    expect(shown[0].body).toContain('/data/harness.yml');
    expect(shown[0].body).toContain('read-only file system');
  });

  /** A rejection carrying a string, which a promise chain is free to do. */
  it('says something for what was thrown even when it is not an error', () => {
    quiet();
    cannotRun('the manifest is not there');
    expect(shown[0].body).toBe('the manifest is not there');
  });

  it('exits non-zero, so whatever launched it knows', () => {
    quiet();
    cannotRun(new Error('nope'));
    expect(exited).toEqual([1]);
  });

  it('puts the whole error on stderr, where a developer running it from a terminal is looking', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('nope');
    cannotRun(err);
    expect(spy).toHaveBeenCalledWith(err);
  });
});
