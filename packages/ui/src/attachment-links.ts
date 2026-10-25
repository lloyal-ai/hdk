/**
 * A bare attachment address in prose is a link, as GFM makes a bare url one. A model that cites a moment or a
 * page by writing its address, not a markdown link, has still cited it, and the address says exactly what it
 * cites. What counts as an address is media's citation grammar; this step only finds the runs to ask it about,
 * outside links, and leaves the sentence's own closing punctuation out. Code is not text, so it is never read.
 *
 * @category UI
 */
import { parseAttachmentHref, parseAttachmentMoment } from '@lloyal-labs/media';
import { findAndReplace } from 'mdast-util-find-and-replace';
import type { RegExpMatchObject } from 'mdast-util-find-and-replace';
import type { Link, PhrasingContent, Root, Text } from 'mdast';

/** A place in the source, as a node's position names one. */
type Point = NonNullable<Text['position']>['start'];

/** A run that begins with the content plane's scheme, up to whitespace or markdown punctuation. */
const CANDIDATE = /attachment:\/\/[^\s<>()[\]]+/g;
/** Punctuation that closes the sentence around an address rather than belonging to it. */
const CLOSING = /[.,;:!?'"]+$/;
/** What an address inside is already a link, and is left as it is. */
const LINKED = ['link', 'linkReference'] as const;

const isAddress = (run: string): boolean => parseAttachmentMoment(run) !== null || parseAttachmentHref(run) !== null;

/** The point `index` characters into a text node, from where the node itself starts. */
function pointIn(node: Text, index: number): Point | undefined {
  const start = node.position?.start;
  if (start?.offset === undefined) return undefined;
  const lines = node.value.slice(0, index).split('\n');
  const column = lines.length === 1 ? start.column + index : lines[lines.length - 1].length + 1;
  return { line: start.line + lines.length - 1, column, offset: start.offset + index };
}

/** A run that is an address, as a link where it stands; its closing punctuation stays text. Anything else is
 *  not a match. */
function linkAddress(run: string, match: RegExpMatchObject): PhrasingContent[] | false {
  const address = run.replace(CLOSING, '');
  if (!isAddress(address)) return false;
  const node = match.stack[match.stack.length - 1] as Text;
  const start = pointIn(node, match.index);
  const end = pointIn(node, match.index + address.length);
  const link: Link = { type: 'link', url: address, children: [{ type: 'text', value: address }], ...(start && end ? { position: { start, end } } : {}) };
  const closing = run.slice(address.length);
  return closing ? [link, { type: 'text', value: closing }] : [link];
}

/** The remark transform: every attachment address in text outside a link becomes a link. */
export function attachmentLinks() {
  return (tree: Root): void => { findAndReplace(tree, [CANDIDATE, linkAddress], { ignore: [...LINKED] }); };
}
