/**
 * Where a run's work lives. Both boots default it to the process's working directory, which is right
 * for a developer standing in their project and wrong for a packaged app, whose working directory is
 * the read-only bundle. A shell that knows better says so through the environment — the same doctrine
 * the served box already follows for its own machine-scoped values (`PORT`, `MAX_SESSIONS`), and for
 * the same reason: one build serves many machines, so the manifest must not carry one machine's paths.
 */
import { describe, it, expect } from 'vitest';
import { projectRootOf } from '../src/boot';

describe('projectRootOf', () => {
  it('is the working directory when nobody says otherwise', () => {
    expect(projectRootOf({}, {})).toBe(process.cwd());
  });

  it('is what the environment says when a shell has put the work somewhere writable', () => {
    expect(projectRootOf({}, { LLOYAL_PROJECT_ROOT: '/data/fieldnote' })).toBe('/data/fieldnote');
  });

  it('is the caller\'s option above all — an explicit root is a decision, not a default', () => {
    expect(projectRootOf({ projectRoot: '/asked' }, { LLOYAL_PROJECT_ROOT: '/env' })).toBe('/asked');
  });

  it('ignores an empty or blank environment value, which is nothing said rather than a root at /', () => {
    expect(projectRootOf({}, { LLOYAL_PROJECT_ROOT: '' })).toBe(process.cwd());
    expect(projectRootOf({}, { LLOYAL_PROJECT_ROOT: '   ' })).toBe(process.cwd());
  });

  it('treats a blank option the same way — nothing said, so the environment is still heard', () => {
    // A caller that passes through an unset field says nothing, and nothing must not outrank a shell
    // that has put the work somewhere writable. Selecting on presence rather than on blankness would
    // let `projectRoot: ''` fall straight past the environment to the working directory.
    expect(projectRootOf({ projectRoot: '' }, { LLOYAL_PROJECT_ROOT: '/data/fieldnote' })).toBe('/data/fieldnote');
    expect(projectRootOf({ projectRoot: '  ' }, { LLOYAL_PROJECT_ROOT: '/data/fieldnote' })).toBe('/data/fieldnote');
    expect(projectRootOf({ projectRoot: '' }, {})).toBe(process.cwd());
  });

  it('answers an absolute path, so every consumer joining onto it lands in the same place', () => {
    expect(projectRootOf({ projectRoot: 'relative/here' }, {})).toBe(`${process.cwd()}/relative/here`);
    expect(projectRootOf({}, { LLOYAL_PROJECT_ROOT: 'also/relative' })).toBe(`${process.cwd()}/also/relative`);
  });
});
