/**
 * A bare attachment address in prose is a link, as GFM makes a bare url one. A model that cites a moment or a
 * page by writing its address, not a markdown link, has still cited it, and the address says exactly what it
 * cites. What counts as an address is media's citation grammar; this step only finds the runs to ask it about,
 * outside links, and leaves the sentence's own closing punctuation out. Code is not text, so it is never read.
 *
 * A text node's value is decoded: a character reference, an escape, a quote's or a list's own marks are gone
 * from it, so a place in the value is not a place in the source. The address itself is written as it reads, so
 * each link is placed at the same occurrence of its address inside the source its text node spans.
 *
 * @category UI
 */
import { parseAttachmentHref, parseAttachmentMoment } from '@lloyal-labs/media';
import { findAndReplace } from 'mdast-util-find-and-replace';
import type { RegExpMatchObject } from 'mdast-util-find-and-replace';
import type { Link, PhrasingContent, Root, Text } from 'mdast';
import type { Transformer } from 'unified';
import { location } from 'vfile-location';

/** A run that begins with the content plane's scheme, up to whitespace or markdown punctuation. */
const CANDIDATE = /attachment:\/\/[^\s<>()[\]]+/g;
/** Punctuation that closes the sentence around an address rather than belonging to it. */
const CLOSING = /[.,;:!?'"]+$/;
/** What an address inside is already a link, and is left as it is. */
const LINKED = ['link', 'linkReference'] as const;

const isAddress = (run: string): boolean => parseAttachmentMoment(run) !== null || parseAttachmentHref(run) !== null;

/** Where in `source` the address `match` found starts: the occurrence of it, counted within its text node,
 *  that the source the node spans holds at the same count. None when the source does not write it that often. */
function sourceOffset(address: string, match: RegExpMatchObject, source: string): number | undefined {
  const node = match.stack[match.stack.length - 1] as Text;
  const { start, end } = node.position ?? {};
  if (start?.offset === undefined || end?.offset === undefined) return undefined;
  const earlier = node.value.slice(0, match.index).split(address).length - 1;
  const pieces = source.slice(start.offset, end.offset).split(address);
  return pieces.length > earlier + 1 ? start.offset + pieces.slice(0, earlier + 1).join(address).length : undefined;
}

/** A run that is an address, as a link where the source writes it; its closing punctuation stays text. Anything
 *  else is not a match. */
function linkAddress(run: string, match: RegExpMatchObject, source: string, place: ReturnType<typeof location>): PhrasingContent[] | false {
  const address = run.replace(CLOSING, '');
  if (!isAddress(address)) return false;
  const offset = sourceOffset(address, match, source);
  const start = offset === undefined ? undefined : place.toPoint(offset);
  const end = offset === undefined ? undefined : place.toPoint(offset + address.length);
  const link: Link = { type: 'link', url: address, children: [{ type: 'text', value: address }], ...(start && end ? { position: { start, end } } : {}) };
  const closing = run.slice(address.length);
  return closing ? [link, { type: 'text', value: closing }] : [link];
}

/** The remark transform: every attachment address in text outside a link becomes a link. */
export function attachmentLinks(): Transformer<Root> {
  return (tree, file) => {
    const source = String(file);
    const place = location(file);
    findAndReplace(tree, [CANDIDATE, (run: string, match: RegExpMatchObject) => linkAddress(run, match, source, place)], { ignore: [...LINKED] });
  };
}
