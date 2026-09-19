/**
 * Facts about a markdown body, read with the grammar that renders it. `Markdown`
 * draws prose through remark; the headings and links a view derives from the
 * same prose — an outline, citation chips, the id a heading is given — come from
 * the same parser, so what the outline names is what the page shows, by
 * construction: a heading's `text` here is the string its rendered element
 * contains, inline markup and all resolved.
 *
 * Two grammars are used on purpose, split by concern. Facts (this module's
 * `headingsOf`, `linksOf`) come from remark, once per body, memoized. The
 * streaming boundary (`splitStreaming`) comes from marked's block lexer, which
 * runs on every token over the whole buffer and is fifteen times cheaper — and
 * a boundary it misjudges costs one extra parse of one block, never a wrong
 * document, so it need not agree with the renderer to the byte.
 *
 * Framework-free: a node script, the Ink view and the browser page read the
 * same facts.
 *
 * @packageDocumentation
 * @category UI
 */
import { lexer } from 'marked';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString } from 'mdast-util-to-string';
import type { Root, Content } from 'mdast';

export interface Heading {
  /** 1–6, the `#` count. */
  depth: number;
  /** The heading as rendered: inline markup resolved to the text it wraps. */
  text: string;
  /** Where the heading starts in the body, in characters. */
  offset: number;
}

export interface Link {
  href: string;
  /** The link's text as rendered. */
  text: string;
  /** Where the link starts in the body, in characters. */
  offset: number;
}

export interface Anchor {
  /** The element id: `<prefix>-<slug>`, numbered from the second repeat (`-2`, `-3`, …). */
  anchor: string;
  text: string;
  depth: number;
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** Parsed bodies, most recent last. A canvas reads the settled body, its exchanges and the sections in one pass,
 *  so a one-entry memo would thrash; an unbounded one would pin every body a session ever showed. */
const parsed = new Map<string, Root>();
const KEEP = 16;

function rootOf(markdown: string): Root {
  const hit = parsed.get(markdown);
  if (hit) {
    parsed.delete(markdown);
    parsed.set(markdown, hit);
    return hit;
  }
  const root = parser.parse(markdown) as Root;
  parsed.set(markdown, root);
  if (parsed.size > KEEP) parsed.delete(parsed.keys().next().value as string);
  return root;
}

function* walk(nodes: readonly Content[]): Generator<Content> {
  for (const node of nodes) {
    yield node;
    if ('children' in node && Array.isArray(node.children)) yield* walk(node.children as Content[]);
  }
}

/** Every heading in document order. */
export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  for (const node of walk(rootOf(markdown).children)) {
    if (node.type === 'heading') out.push({ depth: node.depth, text: toString(node), offset: node.position?.start.offset ?? 0 });
  }
  return out;
}

/** Every link in document order, as the renderer draws them: inline links, the bare urls GFM links, and
 *  reference-style links resolved through their definitions (an unresolved reference renders as text and is
 *  not a link). */
export function linksOf(markdown: string): Link[] {
  const root = rootOf(markdown);
  const definitions = new Map<string, string>();
  for (const node of walk(root.children)) {
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
  }
  const out: Link[] = [];
  for (const node of walk(root.children)) {
    const offset = node.position?.start.offset ?? 0;
    if (node.type === 'link') out.push({ href: node.url, text: toString(node), offset });
    else if (node.type === 'linkReference') {
      const href = definitions.get(node.identifier);
      if (href !== undefined) out.push({ href, text: toString(node), offset });
    }
  }
  return out;
}

const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'h';

/** The id each heading is given under `prefix`, in document order — the ONE derivation, so an outline that
 *  names an anchor and the prose that carries it cannot disagree. A repeated heading is numbered from its
 *  second appearance, and the number is taken against the ids already given out, not the slug's count: `A`,
 *  `A`, `A-2` become `a`, `a-2`, `a-2-2`, never two `a-2`s. A renderer assigns these to its heading elements
 *  in the same order. */
export function anchorsOf(headings: readonly Heading[], prefix: string): Anchor[] {
  const given = new Set<string>();
  return headings.map((h) => {
    const base = `${prefix}-${slugify(h.text)}`;
    let anchor = base;
    for (let n = 2; given.has(anchor); n++) anchor = `${base}-${n}`;
    given.add(anchor);
    return { anchor, text: h.text, depth: h.depth };
  });
}

/** Where streaming prose stops being finished. Everything up to the last block CommonMark recognises is
 *  complete, parsed once and kept while it stands; the last block is the one still being written, parsed per
 *  token. The boundaries are marked's — a spec-tested block tokenizer, used here only to find where the last
 *  block starts: a loose list is one block, a fence owns its blank lines. A block boundary this misjudges
 *  would cost one extra parse of one block, never a wrong document — with one exception the split refuses: a
 *  reference definition resolves links in EARLIER blocks, so a head rendered without it would show those
 *  references as text; a document that carries one is kept whole in the tail. */
export function splitStreaming(markdown: string): { head: string; tail: string } {
  // marked reports raw text with line endings normalised; normalise first so head + tail is the text parsed.
  const text = markdown.replace(/\r\n?/g, '\n');
  const tokens = lexer(text);
  if (tokens.length < 2 || tokens.some((t) => t.type === 'def')) return { head: '', tail: text };
  const cut = text.length - tokens[tokens.length - 1].raw.length;
  return { head: text.slice(0, cut), tail: text.slice(cut) };
}
