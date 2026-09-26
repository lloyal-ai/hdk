/**
 * The citation weave: turns a report's `result` and its grammar-forced
 * `sources: [{ title, url }]` into already-inline-cited text, at capture. A
 * synthesizer mirrors the citation FORMAT of its input, so the durable way to
 * get inline citations is to seed them in the findings themselves.
 *
 * For each source: replace every BARE occurrence of the exact url with
 * `[title](url)`, skipping urls already inside a markdown link (preceded by
 * `](`) or in parentheses (preceded by `(`), and stopping at a url boundary so
 * a shorter source url that is a prefix of a longer url in the body is not
 * corrupted; then append a trailing `Sources:` list. Sources are de-duplicated
 * by url and processed LONGEST-url-first. Pure and defensive: a non-string
 * result or an empty, absent or non-array `sources` returns `result` unchanged.
 *
 * @category Rig
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { toString } from 'mdast-util-to-string';
import type { Root, Nodes, Parent, RootContent } from 'mdast';

/** A structured source as the `report` output emits it. */
export interface WeaveSource {
  title: string;
  url: string;
}

// A source url must not wrap when the very next character continues a url — else
// a declared root like `https://a.io` would corrupt a longer body url such as
// `https://a.io/guide`, and a query string would be severed from its link. Two
// lookaheads: the next char is not a url-continuation char, and not a `.` that
// itself continues the url (a `.` at end of string or before whitespace is a
// sentence terminator, so a sentence-final url still wraps).
const URL_BOUNDARY = '(?![\\w/?#=&~%+@:-])(?!\\.[\\w/])';

export function weaveSourcesIntoResult(result: string, sources: unknown): string;
export function weaveSourcesIntoResult(result: unknown, sources: unknown): unknown;
export function weaveSourcesIntoResult(result: unknown, sources: unknown): unknown {
  if (typeof result !== 'string' || !Array.isArray(sources) || sources.length === 0) {
    return result;
  }
  const seen = new Set<string>();
  const clean: WeaveSource[] = [];
  for (const s of sources as unknown[]) {
    if (!s || typeof s !== 'object') continue;
    const rec = s as { url?: unknown; title?: unknown };
    if (typeof rec.url !== 'string' || typeof rec.title !== 'string') continue;
    const url = rec.url.trim();
    const title = rec.title.trim();
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    clean.push({ url, title });
  }
  // Longest url first — a shorter prefix url must not corrupt a longer occurrence.
  clean.sort((a, b) => b.url.length - a.url.length);

  let out = result;
  const lines: string[] = [];
  for (const { url, title } of clean) {
    // Escape `[`/`]` in the title so a bracketed page title cannot break the link syntax.
    const safeTitle = title.replace(/[[\]]/g, '\\$&');
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Capture a preceding `](` (already a link target) or `(` (parens) so those
    // occurrences are left untouched; a bare occurrence has no prefix → wrap it.
    const re = new RegExp('(\\]\\(|\\()?' + esc + URL_BOUNDARY, 'g');
    out = out.replace(re, (m, pre) => (pre ? m : `[${safeTitle}](${url})`));
    lines.push(`- [${safeTitle}](${url})`);
  }
  if (lines.length > 0) out = out + '\n\nSources:\n' + lines.join('\n');
  return out;
}

/** The heading that names the list, as its text reads: "Sources", "References", with or without a colon. */
const LIST_HEAD = /^(?:sources|references)\s*:?$/i;

/** An HTML anchor as a model writes one: the href in either quote, any other attributes, the text inside. */
const HTML_ANCHOR = /<a\s+[^>]*?href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
/** An anchor's opening tag alone, and its closing tag alone — how inline HTML reaches the tree, the text between as its own node. */
const ANCHOR_OPEN = /^<a\s+[^>]*?href=(["'])([^"']+)\1[^>]*>$/i;
const ANCHOR_CLOSE = /^<\/a>$/i;

/** The grammar the renderer draws: the one the weave reads, so what it edits is what a reader sees as prose. */
const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** A rewrite of one span of the source, by offset. */
interface Edit { start: number; end: number; text: string }

/** What is never prose: a link's own text, a reference, code, math, HTML. A text node under any of these is left as written. */
const NOT_PROSE = new Set(['link', 'linkReference', 'definition', 'inlineCode', 'code', 'math', 'inlineMath', 'html', 'image', 'imageReference']);

const isParent = (n: Nodes): n is Nodes & Parent => 'children' in n;
const startOf = (n: Nodes): number => n.position!.start.offset!;
const endOf = (n: Nodes): number => n.position!.end.offset!;

/**
 * The other half of the weave, for prose that cites its own way: a settled answer whose claims say `[2]`
 * with the links only in a trailing "Sources" list, or whose links are HTML anchors. An anchor becomes the
 * markdown link it means, since the renderer draws markdown links and nothing else. Then each bare `[n]` in
 * PROSE — text the parser reads as text: not a link's own text, not a reference the body defines, not code,
 * not math — becomes `[n](url)`, the url being the nth entry of that list in the order the model wrote it, so
 * the reader meets a link at the claim, as the weave gives a report. The list stays; everything the weave does
 * not touch is byte for byte what the model wrote. Pure.
 *
 * @category Rig
 */
export function weaveOrdinalCitations(result: string): string {
  const tree = markdown.parse(result) as Root;
  const edits: Edit[] = [];

  // Anchors first, wherever HTML reaches the tree: a node holding whole anchors (a paragraph that is HTML) is
  // rewritten within; an opening tag closed by a later sibling takes the span between them, the text as it is.
  // An anchor whose text is itself a bracketed number, `<a href>[2]</a>`, sheds the brackets: `[2](url)`, the
  // weave's own bare-citation form, not a link whose text is "[2]".
  const link = (url: string, text: string): string => {
    const t = text.trim();
    const bare = /^\[(\d+)\]$/.exec(t);
    return `[${bare ? bare[1] : t}](${url})`;
  };
  const walk = (node: Nodes, parents: Nodes[]): void => {
    if (!isParent(node)) return;
    const kids = node.children as RootContent[];
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if (kid.type === 'html') {
        const open = ANCHOR_OPEN.exec(kid.value);
        if (open) {
          const j = kids.findIndex((k, at) => at > i && k.type === 'html' && ANCHOR_CLOSE.test(k.value));
          if (j !== -1) {
            edits.push({ start: startOf(kid), end: endOf(kids[j]), text: link(open[2], result.slice(endOf(kid), startOf(kids[j]))) });
            i = j;
            continue;
          }
        }
        const within = kid.value.replace(HTML_ANCHOR, (_m, _q, url: string, text: string) => link(url, text));
        if (within !== kid.value) edits.push({ start: startOf(kid), end: endOf(kid), text: within });
        continue;
      }
      walk(kid, [...parents, node]);
    }
  };
  walk(tree, []);

  // The trailing list: the last thing the model wrote is a list whose every item is one link, and the thing
  // before it names it. Only the prose above that name is woven.
  const top = tree.children;
  const list = top.at(-1);
  const name = top.at(-2);
  const urls: string[] = [];
  if (list?.type === 'list' && name && (name.type === 'heading' || name.type === 'paragraph') && LIST_HEAD.test(toString(name).trim())) {
    for (const item of list.children) {
      const para = item.children.length === 1 && item.children[0].type === 'paragraph' ? item.children[0] : undefined;
      const links = para?.children.filter((c) => !(c.type === 'text' && c.value.trim() === '')) ?? [];
      const only = links.length === 1 && links[0].type === 'link' ? links[0] : undefined;
      if (!only) { urls.length = 0; break; }
      urls.push(only.url);
    }
  }
  if (urls.length > 0) {
    const above = startOf(name!);
    // A number the body defines is a reference link already, with its own url.
    const defined = new Set<string>();
    const consumed = edits.map((e) => [e.start, e.end] as const);
    const inAnchor = (at: number): boolean => consumed.some(([s, e]) => at >= s && at < e);
    const prose = (node: Nodes, parents: Nodes[]): void => {
      if (isParent(node)) { for (const kid of node.children) prose(kid, [...parents, node]); return; }
      if (node.type !== 'text' || parents.some((p) => NOT_PROSE.has(p.type))) return;
      const at = startOf(node);
      if (at >= above || inAnchor(at)) return;
      // The SOURCE of the node, not its value: the parser has already unescaped `\*` and decoded `&lt;` in the
      // value, and writing that back would change what renders. An escaped `\[1]` is no citation either.
      const source = result.slice(at, endOf(node));
      const woven = source.replace(/(^|[^\]\\>[])\[(\d+)\](?![(:])/g, (m, before: string, n: string) => {
        const url = defined.has(n) ? undefined : urls[Number(n) - 1];
        return url ? `${before}[${n}](${url})` : m;
      });
      if (woven !== source) edits.push({ start: at, end: endOf(node), text: woven });
    };
    // Definitions anywhere in the body count, so they are read before any text is woven.
    const collect = (node: Nodes): void => { if (node.type === 'definition' && /^\d+$/.test(node.identifier)) defined.add(node.identifier); if (isParent(node)) node.children.forEach(collect); };
    collect(tree);
    prose(tree, []);
  }

  if (edits.length === 0) return result;
  edits.sort((a, b) => b.start - a.start);
  let out = result;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
