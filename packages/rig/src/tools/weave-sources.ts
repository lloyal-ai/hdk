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

/**
 * A list line: an optional bullet or number, then a markdown link — what a model writes under "Sources". The url
 * is read to the link's closing paren, not the first one: a Wikipedia title carries its own, `…/Alien_(film)`.
 */
const LIST_LINK = /^\s*(?:[-*]|\d+[.)])?\s*\[[^\]]*\]\(((?:[^()\s]|\([^()\s]*\))+)\)\s*$/;
/**
 * The heading that names the list: "Sources", "References", plain, bold or a markdown heading (bold inside it too),
 * with or without a colon — on either side of the closing emphasis.
 */
const LIST_HEAD = /^\s*(?:#{1,4}\s+)?(?:\*\*)?(?:sources|references)\s*:?\s*(?:\*\*)?\s*:?\s*$/i;

/** An HTML anchor as a model writes one: the href in either quote, any other attributes, the text inside. */
const HTML_ANCHOR = /<a\s+[^>]*?href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * The other half of the weave, for prose that cites its own way: a settled answer whose claims say `[2]`
 * with the links only in a trailing "Sources" list, or whose links are HTML anchors. An anchor becomes the
 * markdown link it means, since the renderer draws markdown links and nothing else. Then each bare `[n]` —
 * not already a link's text, not a reference definition — becomes `[n](url)`, the url being the nth entry of
 * that list in the order the model wrote it, so the reader meets a link at the claim, as the weave gives a
 * report. The list stays; a body with neither is returned unchanged. Pure.
 *
 * @category Rig
 */
export function weaveOrdinalCitations(result: string): string {
  // An anchor whose text is itself a bracketed number, `<a href>[2]</a>`, sheds the brackets: `[2](url)`, the
  // weave's own bare-citation form, not a link whose text is "[2]". Never inside code, where an anchor is a
  // literal example.
  const unanchored = outsideCode(result, (prose) => prose.replace(HTML_ANCHOR, (_m, _q, url: string, text: string) => {
    const t = text.trim();
    const bare = /^\[(\d+)\]$/.exec(t);
    return `[${bare ? bare[1] : t}](${url})`;
  }));
  const lines = unanchored.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  // Read the list from the bottom: link lines, blank lines between them, then the heading that names it.
  const urls: string[] = [];
  let i = end;
  while (i > 0) {
    const line = lines[i - 1];
    const m = LIST_LINK.exec(line);
    if (m) { urls.unshift(m[1]); i--; continue; }
    if (line.trim() === '' && urls.length > 0) { i--; continue; }
    break;
  }
  while (i > 0 && lines[i - 1].trim() === '') i--;
  if (urls.length === 0 || i < 1 || !LIST_HEAD.test(lines[i - 1])) return unanchored;
  // Only the prose above the heading is woven; a `[n]` is bare when nothing links or defines it — not a
  // markdown link's text (`[n](`), not a definition (`[n]:`), not an HTML anchor's text (`>[n]</a>`), which a
  // model that weaves its own links writes as readily as markdown — and never inside code, where `list[2]`
  // is an index. Code is every CommonMark spelling: a backtick or tilde fence, a span of any backtick run.
  const head = lines.slice(0, i - 1).join('\n');
  const tail = lines.slice(i - 1).join('\n');
  const woven = outsideCode(head, (prose) => prose.replace(/(^|[^\]\\>[])\[(\d+)\](?![(:])/g, (m, before: string, n: string) => {
    const url = urls[Number(n) - 1];
    return url ? `${before}[${n}](${url})` : m;
  }));
  return woven === head ? unanchored : `${woven}\n${tail}`;
}

/** Code as CommonMark spells it: a fence of three or more backticks or tildes closed by its own run, or a span closed by its own run. */
const CODE = /(`{3,})[\s\S]*?\1|(~{3,})[\s\S]*?\2|(`+)[\s\S]*?\3/g;

/** `text` with `rewrite` applied to every stretch of prose between its code, the code kept byte for byte. */
function outsideCode(text: string, rewrite: (prose: string) => string): string {
  let out = '';
  let at = 0;
  for (const code of text.matchAll(CODE)) {
    out += rewrite(text.slice(at, code.index)) + code[0];
    at = code.index + code[0].length;
  }
  return out + rewrite(text.slice(at));
}
