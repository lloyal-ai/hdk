/**
 * Where a harness's files are when it is an installed application rather than a project directory.
 *
 * In development there is one place and it is the working directory. A packaged app has two, and
 * they are two because of what the operating system allows rather than by design:
 *
 * - **The application's own files** — the compiled engine, its dependencies and the prompt folder —
 *   ship inside the bundle and are read-only. Most of them live in the `asar` archive, which
 *   Electron reads and the operating system cannot make a working directory, so the engine's `cwd`
 *   is the archive's real parent and anything resolved through `cwd` is unpacked beside it.
 * - **Everything a run produces** — the manifest it reads, the overlay it writes, the model slots it
 *   fills, the content store, the folders it keeps — goes somewhere writable, which the platform
 *   gives us per installation and per user.
 *
 * The manifest belongs to both: it ships as the application's default and becomes the
 * installation's own the first time it launches. {@link seedIfAbsent} is that copy, and it happens
 * once — an update brings new code, never a rewrite of a file the reader now owns.
 *
 * @category Desktop
 */
import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The manifest, by the one name rig reads it under. */
const MANIFEST = 'harness.yml';

/** Where a harness's files are. In development every field is the working directory. */
export interface HarnessPlacement {
  /** The application's own files: the engine entry and everything it imports. Read-only when packaged. */
  readonly appPath: string;
  /** The engine's working directory — a real directory, never inside the archive. What `cwd`-relative
   *  application assets resolve against, the prompt folder above all. */
  readonly cwd: string;
  /** Where this installation's work lives: the manifest, the overlay, the models, the media store and
   *  the folders the app keeps. Handed to the engine as its project root, and to the content scheme. */
  readonly dataRoot: string;
  /** True when these are three different places rather than one. */
  readonly packaged: boolean;
}

/** Could not give a fresh installation its manifest. Carries both paths, because which one is wrong
 *  is the whole question, and the reader can only be told if we say. */
export class SeedFailed extends Error {
  constructor(readonly from: string, readonly to: string, readonly cause: unknown) {
    super(`could not create ${to} from ${from}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SeedFailed';
  }
}

/**
 * Copy the application's default manifest into a fresh installation, once.
 *
 * Returns `present` without reading anything when the installation already has one: what is there is
 * the reader's, including every edit and every model they have chosen since.
 *
 * The copy lands whole or not at all. It is written beside its destination under a name carrying this
 * process's id and then renamed, which is atomic on one filesystem, so a first launch interrupted
 * half way leaves nothing for the next launch to mistake for a seeded manifest. A failure removes
 * what it wrote and says which file it could not manage.
 */
export function seedIfAbsent(from: string, to: string): 'seeded' | 'present' {
  // A directory in the manifest's place is not a manifest; fall through, fail on the rename, and say so.
  if (existsSync(to) && statSync(to).isFile()) return 'present';
  const partial = `${to}.${process.pid}.${randomBytes(4).toString('hex')}.partial`;
  try {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, partial);
    renameSync(partial, to);
    return 'seeded';
  } catch (cause) {
    try { rmSync(partial, { force: true }); } catch { /* the failure below is the one worth reporting */ }
    throw new SeedFailed(from, to, cause);
  }
}

/**
 * Where this harness's files are, and — on a first packaged launch — its manifest put in place.
 *
 * Call it once, before the engine is forked. It throws {@link SeedFailed} when a packaged app cannot
 * be given its manifest, which is a broken installation rather than a bad run: the caller shows it
 * and stops, because an engine started without one would only fail further in with less to say.
 */
export function placeHarness(): HarnessPlacement {
  if (!app.isPackaged) {
    const here = process.cwd();
    return { appPath: here, cwd: here, dataRoot: here, packaged: false };
  }
  const place: HarnessPlacement = {
    appPath: app.getAppPath(),
    cwd: process.resourcesPath,
    dataRoot: app.getPath('userData'),
    packaged: true,
  };
  seedIfAbsent(join(place.appPath, MANIFEST), join(place.dataRoot, MANIFEST));
  return place;
}
