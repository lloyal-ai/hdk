/**
 * `sharp`, required at call time rather than imported at module load: it is a
 * native dependency, and a harness that never handles an image should not pay
 * its load. `missing` names the install, because the failure is a missing
 * package, not a bad picture.
 */
export function loadSharp(missing: string): typeof import('sharp').default {
  try {
    // sharp's CJS export is the callable itself; its types put it on `default`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('sharp');
  } catch {
    throw new Error(missing);
  }
}
