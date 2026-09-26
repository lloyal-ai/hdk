/**
 * A config as a bag of bags, and the dotted-path walk over it — the ONE copy every module that reads or
 * writes a layered config shares: the table's merge, the loader, the settings pane's patch resolution.
 * Node-free.
 *
 * @category Rig
 */
export type Bag = Record<string, unknown>;

/** A bag holds keys; a scalar — or an array — is one value, however deep the table goes. */
export const isBag = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The value at a dotted path, or undefined where the path leaves the bags. */
export function getPath(bag: unknown, dotted: string): unknown {
  let node: unknown = bag;
  for (const seg of dotted.split('.')) {
    if (!isBag(node)) return undefined;
    node = node[seg];
  }
  return node;
}

/** Set the value at a dotted path in place, making every bag along the way. */
export function setPath(bag: Bag, dotted: string, value: unknown): void {
  const segs = dotted.split('.');
  let node = bag;
  for (const seg of segs.slice(0, -1)) {
    const next = node[seg];
    if (!isBag(next)) node[seg] = {};
    node = node[seg] as Bag;
  }
  node[segs[segs.length - 1]] = value;
}

/** The bag with the value at `segs` replaced, every level along the way copied; the bag itself when the path is
 *  not there. */
export function withPath(bag: Bag, segs: readonly string[], value: unknown): Bag {
  const [head, ...rest] = segs;
  if (rest.length === 0) return { ...bag, [head]: value };
  const inner = bag[head];
  return isBag(inner) ? { ...bag, [head]: withPath(inner, rest, value) } : bag;
}
