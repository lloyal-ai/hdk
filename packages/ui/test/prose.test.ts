/**
 * The facts of a markdown body come from the grammar that renders it; the streaming boundary from marked's
 * block lexer. What an outline names is what the page shows, and the cost of rendering prose as it streams
 * does not grow with the prose.
 */
import { describe, it, expect } from 'vitest';
import { lexer } from 'marked';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { headingsOf, linksOf, anchorsOf, splitStreaming, admitUrl } from '../src/prose';

describe('headingsOf / linksOf', () => {
  it('a heading\'s text is the rendered text: inline markup resolved, at its offset, at its depth', () => {
    const md = 'intro\n\n## A *styled* [linked](https://x.y) `code` heading\n\n### Plain\n\n```\n# not a heading\n```\n\n#### Deep';
    expect(headingsOf(md)).toEqual([
      { depth: 2, text: 'A styled linked code heading', offset: md.indexOf('## A') },
      { depth: 3, text: 'Plain', offset: md.indexOf('### Plain') },
      { depth: 4, text: 'Deep', offset: md.indexOf('#### Deep') },
    ]);
  });

  it('math is math, as the renderer has it — underscores inside $…$ are not emphasis', () => {
    const [h] = headingsOf('## Mass $m_1$ and $m_2$ summed');
    expect(h.text).toBe('Mass m_1 and m_2 summed');
    expect(anchorsOf([h], 'a')[0].anchor).toBe('a-mass-m-1-and-m-2-summed');
  });

  it('links are every link the renderer would draw, in order, with their rendered text', () => {
    const md = 'See [Oslo](https://a.io/oslo) and [**A**](https://a.io) twice: [A](https://a.io).\n\n- [in a list](https://l.io)\n\n> [quoted](https://q.io)';
    expect(linksOf(md).map((l) => [l.href, l.text])).toEqual([
      ['https://a.io/oslo', 'Oslo'], ['https://a.io', 'A'], ['https://a.io', 'A'], ['https://l.io', 'in a list'], ['https://q.io', 'quoted'],
    ]);
    expect(linksOf(md)[0].offset).toBe(4);
  });

  it('a bare url is a link too — the renderer links it, so the reader can click it', () => {
    expect(linksOf('see https://bare.io/x now').map((l) => l.href)).toEqual(['https://bare.io/x']);
  });

  it('a reference-style link resolves through its FIRST definition; an unresolved reference is text, not a link', () => {
    const md = 'See [the paper][p] and [nothing][gone].\n\n[p]: https://p.io/paper\n[p]: https://p.io/other';
    expect(linksOf(md)).toEqual([{ href: 'https://p.io/paper', text: 'the paper', offset: 4 }]);
  });

  it('an href is what the renderer would carry: an unsafe scheme is stripped, the content plane\'s is admitted', () => {
    const md = '[x](javascript:alert(1)) [y](https://ok.io) [z](attachment://r/page/2) [w](/relative) [v][d]\n\n[d]: data:text/html,hi';
    expect(linksOf(md).map((l) => l.href)).toEqual(['', 'https://ok.io', 'attachment://r/page/2', '/relative', '']);
    expect(admitUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(admitUrl('https://x/y:z')).toBe('https://x/y:z');
    expect(admitUrl('vbscript:x')).toBe('');
  });

  it('the same body parses once: the facts come back identical while it stands', () => {
    const md = '## H\n\n[a](https://a)';
    expect(headingsOf(md)).toEqual(headingsOf(md));
    expect(linksOf(md)).toEqual(linksOf(md));
  });
});

describe('anchorsOf', () => {
  it('one id per heading under the prefix; a repeated heading is numbered from its second appearance', () => {
    const headings = headingsOf('# Intro\n\n## Results\n\n## Results\n\n## Results\n\n## Über: café!');
    expect(anchorsOf(headings, 'a').map((x) => x.anchor)).toEqual(['a-intro', 'a-results', 'a-results-2', 'a-results-3', 'a-ber-caf']);
    expect(anchorsOf(headings, 's1')[0]).toEqual({ anchor: 's1-intro', text: 'Intro', depth: 1 });
  });

  it('ids are unique against those already given, not against the slug\'s count', () => {
    const headings = headingsOf('## A\n\n## A\n\n## A-2\n\n## A');
    expect(anchorsOf(headings, 'a').map((x) => x.anchor)).toEqual(['a-a', 'a-a-2', 'a-a-2-2', 'a-a-3']);
  });

  it('an empty or over-long slug is still an id', () => {
    const headings = headingsOf('## ???\n\n## ' + 'word '.repeat(30));
    const [empty, long] = anchorsOf(headings, 'a');
    expect(empty.anchor).toBe('a-h');
    expect(long.anchor.length).toBeLessThanOrEqual('a-'.length + 60);
  });
});

/** The renderer's tree over the split, positions dropped: the head's nodes then the tail's must be the whole
 *  document's nodes — the same types, text, hrefs and math, not just the same kinds. */
const tree = (md: string): unknown[] => {
  const strip = (n: unknown): unknown =>
    Array.isArray(n) ? n.map(strip)
    : n && typeof n === 'object' ? Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'position').map(([k, v]) => [k, strip(v)]))
    : n;
  return strip((unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(md) as { children: unknown[] }).children) as unknown[];
};
const splitTree = (md: string): unknown[] => {
  const { head, tail } = splitStreaming(md);
  return [...tree(head), ...tree(tail)];
};

describe('splitStreaming renders the same tree split as whole', () => {
  it.each([
    'para one\n\n## Heading\n\n- a\n- b\n\npara two',
    'before\n\n```\ncode\n\nmore\n```\n\nafter',
    'intro\n\n$$\na = b\n\nc = d\n$$\n\nafter',
    'intro\n\n$$\na = b\n\nc = d',
    'The marker is `$$`.\n\n$$\na = b\n\nc = d\n$$',
    'intro\n\n$$$$\na = b\n\nc = d\n$$$$\n\nafter',
    '[x][id]\n\n> quoted\n>\n> [id]: https://e\n\npara',
    'text with $inline$ math\n\nand more',
    'see [a](https://a.io) then\n\n[b][r]\n\n[r]: https://r.io',
  ])('%s', (md) => {
    expect(splitTree(md)).toEqual(tree(md));
  });
});

describe('splitStreaming', () => {
  it('the tail is the last block CommonMark recognises — a fence owns its blank lines, a loose list is one block', () => {
    expect(splitStreaming('no blank line yet')).toEqual({ head: '', tail: 'no blank line yet' });
    expect(splitStreaming('done.\n\nnext')).toEqual({ head: 'done.\n\n', tail: 'next' });
    const open = 'before\n\n```\ncode\n\nmore code';
    expect(splitStreaming(open)).toEqual({ head: 'before\n\n', tail: '```\ncode\n\nmore code' });
    const closed = 'before\n\n```\ncode\n\nmore\n```\n\nafter';
    expect(splitStreaming(closed)).toEqual({ head: 'before\n\n```\ncode\n\nmore\n```\n\n', tail: 'after' });
    expect(splitStreaming('').tail).toBe('');
    // A fence inside a list item is part of the list, which is one block while it is being written.
    const nested = 'intro\n\n- item\n\n  ```\n  code\n\n  more';
    expect(splitStreaming(nested)).toEqual({ head: 'intro\n\n', tail: '- item\n\n  ```\n  code\n\n  more' });
    // A fence closes only on the same character, at least as long, with nothing after it.
    const longer = 'before\n\n````md\ncode\n\n```\nstill code\n\nmore';
    expect(splitStreaming(longer)).toEqual({ head: 'before\n\n', tail: '````md\ncode\n\n```\nstill code\n\nmore' });
    const trailing = 'before\n\n```\ncode\n```not-a-close\nstill code\n\nmore';
    expect(splitStreaming(trailing)).toEqual({ head: 'before\n\n', tail: '```\ncode\n```not-a-close\nstill code\n\nmore' });
    // A loose list is one block.
    expect(splitStreaming('- a\n\n- b\n\n- c is still')).toEqual({ head: '', tail: '- a\n\n- b\n\n- c is still' });
    // A reference definition resolves links in earlier blocks: a document that carries one — at any depth — is not
    // split, else the memoized head would render its references as text until the whole settles.
    expect(splitStreaming('[x][id]\n\n[id]: https://e\n\npara')).toEqual({ head: '', tail: '[x][id]\n\n[id]: https://e\n\npara' });
    expect(splitStreaming('[x][id]\n\n> quoted\n>\n> [id]: https://e\n\npara').head).toBe('');
    // A display equation spanning a blank line is one node to the renderer and two blocks to marked, and only
    // the renderer's grammar knows a delimiter from a `$$` in inline code: a document with `$$` is never split.
    expect(splitStreaming('intro\n\n$$\na = b\n\nc = d').head).toBe('');
    expect(splitStreaming('intro\n\n$$\na = b\n\nc = d\n$$\n\nafter').head).toBe('');
    expect(splitStreaming('The marker is `$$`.\n\n$$\na = b\n\nc = d\n$$').head).toBe('');
    // A blank line may hold spaces or tabs; CRLF is normalised before the split.
    expect(splitStreaming('first\n  \nsecond\n\t\nthird')).toEqual({ head: 'first\n  \nsecond\n\t\n', tail: 'third' });
    expect(splitStreaming('first\r\n\r\nsecond')).toEqual({ head: 'first\n\n', tail: 'second' });
  });

  const paragraph = (i: number): string =>
    `Paragraph ${i} of the brief says something at the length a model writes, with a [citation](https://x/${i}) ` +
    'and enough words that a token lands in it many times before it ends.'.repeat(2);
  const section = (k: number): string[] => [
    '## Heading one', paragraph(k), '- a list item\n- another item\n- a third', paragraph(k + 1),
    '```ts\nconst inFence = true;\n\n// a blank line INSIDE the fence\nexport {};\n```', '## Heading one', paragraph(k + 2), '> a quote\n> continued', paragraph(k + 3),
  ];
  // About the size of a settled brief (8–10 KB), which is where the whole-buffer cost showed.
  const document = Array.from({ length: 8 }, (_, i) => section(i * 4)).flat().join('\n\n') + '\n';

  /** Replay `text` in `DELTA`-char deltas and account for what a memoized renderer PARSES: the head only
   *  when it changes, the tail every time. The lexer that finds the boundary scans the whole buffer on every
   *  token — linear per token by design, `bytesLexed` counts it — at roughly 30 ns a byte against the
   *  parser's microseconds a byte. */
  const replay = (text: string, DELTA: number) => {
    let headParses = 0; let lastHead = ''; let bytesSplit = 0; let bytesWhole = 0; let bytesLexed = 0; let worstToken = 0; let worstTail = 0;
    for (let n = DELTA; n <= text.length + DELTA; n += DELTA) {
      const buffer = text.slice(0, n);
      const { head, tail } = splitStreaming(buffer);
      expect(head + tail).toBe(buffer);
      let cost = tail.length;
      if (head !== lastHead) { headParses++; cost += head.length; lastHead = head; }
      bytesSplit += cost; bytesWhole += buffer.length; bytesLexed += buffer.length;
      worstToken = Math.max(worstToken, cost); worstTail = Math.max(worstTail, tail.length);
    }
    return { headParses, bytesSplit, bytesWhole, bytesLexed, worstToken, worstTail };
  };

  it('replayed token by token, a token PARSES one block — the head once per block, never per token; the lexer scans all of it', () => {
    const DELTA = 4;
    const blocks = lexer(document);
    const longestBlock = Math.max(...blocks.map((b) => b.raw.length));
    const r = replay(document, DELTA);
    expect(r.headParses).toBeLessThanOrEqual(blocks.length);
    expect(r.worstTail).toBeLessThanOrEqual(longestBlock);
    expect(r.worstToken).toBeLessThanOrEqual(longestBlock + document.length);
    expect(r.bytesSplit * 10).toBeLessThan(r.bytesWhole);
    expect(r.bytesLexed).toBe(r.bytesWhole);
    const half = replay(document.slice(0, Math.floor(document.length / 2)), DELTA);
    expect(half.bytesWhole / half.bytesSplit).toBeLessThan(r.bytesWhole / r.bytesSplit);
  });
});
