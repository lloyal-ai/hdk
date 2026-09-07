/**
 * The layout heuristics, specified on synthetic character records.
 *
 * Nothing here touches the codec: a page is a list of characters with boxes,
 * sizes and weights in PDF user space (origin bottom-left, y up), plus what
 * the page's objects and structure tree said. That is the whole input, so the
 * rules are stated where they can be read.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { layoutDocument } from '../src/pdf-layout';
import type { PageChar, PageFacts } from '../src/pdf-layout';

/** Lay a string of characters on one baseline. Each glyph is `size * 0.5` wide. */
function line(text: string, y: number, opts: { x?: number; size?: number; weight?: number; mcid?: number } = {}): PageChar[] {
  const size = opts.size ?? 10;
  const w = size * 0.5;
  let x = opts.x ?? 72;
  const out: PageChar[] = [];
  for (const ch of text) {
    out.push({ text: ch, x0: x, y0: y, x1: x + w, y1: y + size, size, weight: opts.weight ?? 400, mcid: opts.mcid ?? -1 });
    x += w;
  }
  return out;
}

function page(n: number, chars: PageChar[], extra: Partial<PageFacts> = {}): PageFacts {
  return { page: n, width: 612, height: 792, chars, images: [], pathObjects: 0, textExtracted: true, ...extra };
}

const OPTS = { title: null, bookmarks: [], maxTextPages: 400, dpi: 150, minFigureSidePx: 64, minFigureAreaRatio: 0.02 };

describe('lines and paragraphs', () => {
  it('groups characters by baseline into lines and joins lines of one block into a paragraph', () => {
    const chars = [
      ...line('First line of the paragraph.', 700),
      ...line('Second line of the same paragraph.', 686),
      ...line('A new paragraph after a gap.', 640),
    ];
    const r = layoutDocument({ ...OPTS, pages: [page(1, chars)] });
    expect(r.markdown).toContain('First line of the paragraph. Second line of the same paragraph.');
    expect(r.markdown).toContain('\n\nA new paragraph after a gap.');
  });

  it('joins a hyphenated line break without the hyphen when the next line starts lowercase', () => {
    const chars = [...line('This is a hyphen-', 700), ...line('ated word here.', 686)];
    const r = layoutDocument({ ...OPTS, pages: [page(1, chars)] });
    expect(r.markdown).toContain('hyphenated word here.');
  });

  it('inserts a space where glyphs leave a gap on one baseline', () => {
    const chars = [...line('left', 700, { x: 72 }), ...line('right', 700, { x: 200 })];
    const r = layoutDocument({ ...OPTS, pages: [page(1, chars)] });
    expect(r.markdown).toContain('left right');
  });
});

describe('headings and the title, by size and weight', () => {
  const doc = () => [
    ...line('A Report Title', 720, { size: 18 }),
    ...line('First Section', 688, { size: 14 }),
    ...line('Body text in the first section, long enough to be body.', 670),
    ...line('Body text continues for a second line here.', 656),
    ...line('Subheading', 630, { size: 12 }),
    ...line('More body text under the subheading.', 612),
    ...line('Bold lead', 590, { weight: 700 }),
    ...line('Body after a bold short line.', 576),
  ];

  it('takes the largest line on page one as the title when metadata has none', () => {
    const r = layoutDocument({ ...OPTS, pages: [page(1, doc())] });
    expect(r.title).toBe('A Report Title');
    expect(r.markdown.startsWith('# A Report Title\n')).toBe(true);
  });

  it('trusts a metadata title only when a heading-size line on page one carries it', () => {
    // A producer's Title field is often junk — here an e-mail that also runs
    // in the footer at body size. The page's largest line is the title.
    const chars = [...doc(), ...line('someone@example.com', 40, { size: 8 })];
    const r = layoutDocument({ ...OPTS, title: 'someone@example.com', pages: [page(1, chars)] });
    expect(r.title).toBe('A Report Title');
    expect(r.markdown.startsWith('# A Report Title\n')).toBe(true);
  });

  it('takes a metadata title the page carries, and does not repeat it as a heading', () => {
    const r = layoutDocument({ ...OPTS, title: 'A Report Title', pages: [page(1, doc())] });
    expect(r.title).toBe('A Report Title');
    expect(r.markdown.match(/^# /gm)).toHaveLength(1);
    expect(r.markdown).not.toMatch(/^## A Report Title$/m);
  });

  it('keeps a metadata title only for a page with no text to corroborate it', () => {
    const r = layoutDocument({ ...OPTS, title: 'From Metadata', pages: [page(1, [], { images: [{ index: 0, bbox: [0, 0, 612, 792] }] })] });
    expect(r.title).toBe('From Metadata');
  });

  it('folds a metadata title that wraps over two lines into the title, not into headings', () => {
    // Chrome prints a long <title> as two 22pt lines; each is a piece of the
    // metadata title, neither equals it. They are the title, so the real
    // sections stay top-level and the table of contents keeps its topics.
    const chars = [
      ...line('Continuous Tree Batching: A', 720, { size: 22 }),
      ...line('Measurement Note', 692, { size: 22 }),
      ...line('Abstract', 660, { size: 14 }),
      ...line('We measure how the cost of a run scales.', 642),
      ...line('Method', 610, { size: 14 }),
      ...line('Each configuration runs the same question.', 592),
    ];
    const r = layoutDocument({ ...OPTS, title: 'Continuous Tree Batching: A Measurement Note', pages: [page(1, chars)] });
    expect(r.markdown.match(/^# /gm)).toHaveLength(1);
    expect(r.markdown).not.toMatch(/^#+ Continuous Tree Batching: A$/m);
    expect(r.markdown).not.toMatch(/^#+ Measurement Note$/m);
    expect(r.sections.map((s) => [s.heading, s.path])).toEqual([
      ['Continuous Tree Batching: A Measurement Note', 'Continuous Tree Batching: A Measurement Note'],
      ['Abstract', 'Abstract'],
      ['Method', 'Method'],
    ]);
  });

  it('ranks heading levels by size and treats a bold short body-size line as the lowest level', () => {
    const r = layoutDocument({ ...OPTS, pages: [page(1, doc())] });
    expect(r.markdown).toContain('\n## First Section\n');
    expect(r.markdown).toContain('\n### Subheading\n');
    expect(r.markdown).toContain('\n#### Bold lead\n');
    expect(r.sections.map((s) => [s.heading, s.path, s.origin])).toEqual([
      ['A Report Title', 'A Report Title', 'heuristic'],
      ['First Section', 'First Section', 'heuristic'],
      ['Subheading', 'First Section > Subheading', 'heuristic'],
      ['Bold lead', 'First Section > Subheading > Bold lead', 'heuristic'],
    ]);
  });

  it('gives every section a contiguous line span that tiles the markdown', () => {
    const r = layoutDocument({ ...OPTS, pages: [page(1, doc())] });
    const lines = r.markdown.split('\n');
    let next = 1;
    for (const s of r.sections) {
      expect(s.startLine).toBe(next);
      expect(lines[s.startLine - 1]).toMatch(new RegExp(`^#+ ${s.heading}$`));
      expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
      next = s.endLine + 1;
    }
    expect(next - 1).toBe(lines.length);
  });
});

describe('separators and wrapped titles', () => {
  it('a synthesised space with no box is a separator, never a line break', () => {
    // PDFium inserts a space between two text runs on one baseline and gives it
    // an empty box. The reader hands it the previous glyph's geometry; the
    // layout treats any whitespace as a separator — either way one line.
    const chars = [
      ...line('2.1', 700, { size: 13 }),
      { text: ' ', x0: 61, y0: 702.7, x1: 61, y1: 702.7, size: 1, weight: 400, mcid: -1 },
      ...line('Structure-Activity Relationship', 700, { x: 96, size: 13 }),
      ...line('Body text under the heading, long enough to be body text.', 680),
      ...line('And a second body line to settle the body size.', 666),
    ];
    const r = layoutDocument({ ...OPTS, pages: [page(1, chars)] });
    expect(r.markdown).toContain('2.1 Structure-Activity Relationship');
    expect(r.markdown).not.toMatch(/^#+ 2\.1$/m);
  });

  it('a ligature drawn from a fallback font with a small em box stays in its word and its line', () => {
    // Chrome sets "fi" from another font: an 8pt-tall advance box on a 20pt
    // line, same baseline. Grouping by baseline keeps "Configuration" whole.
    const big = line('Con', 700, { size: 20 });
    const fi = { text: 'fi', x0: big[big.length - 1].x1 + 0.2, y0: 702, x1: big[big.length - 1].x1 + 3.4, y1: 710.4, size: 8.4, baseline: 700, weight: 400, mcid: -1 };
    const rest = line('guration matters here.', 700, { x: fi.x1 + 0.2, size: 20 });
    const body = [...line('Body text sets the body size for the page here.', 670), ...line('A second body line, so the heading rank has a body.', 656)];
    const r = layoutDocument({ ...OPTS, pages: [page(1, [...big.map((c) => ({ ...c, baseline: 700 })), fi, ...rest.map((c) => ({ ...c, baseline: 700 })), ...body])] });
    expect(r.markdown).toContain('Configuration matters here.');
    expect(r.markdown).not.toContain('Con fi');
  });

  it('the title is the run of largest lettered lines, not a bare chapter number set larger', () => {
    const chars = [
      ...line('2', 730, { size: 30 }),
      ...line('Topical Corticosteroids:', 700, { size: 20 }),
      ...line('Pharmacology', 676, { size: 20 }),
      ...line('Gagandeep Kwatra and Sandip Mukhopadhyay', 650, { size: 12 }),
      ...line('Abstract Topical corticosteroids are widely used for inflammatory disorders.', 630),
      ...line('They are available in a number of formulations for the skin.', 616),
    ];
    const r = layoutDocument({ ...OPTS, title: 'kwatragagandeep@gmail.com', pages: [page(1, chars)] });
    expect(r.title).toBe('Topical Corticosteroids: Pharmacology');
    expect(r.markdown.match(/^# /gm)).toHaveLength(1);
    expect(r.markdown).not.toMatch(/^#+ Pharmacology$/m);
    // The bare chapter number is not a heading either.
    expect(r.markdown).not.toMatch(/^#+ 2$/m);
    expect(r.sections.map((s) => s.heading)).toEqual(['Topical Corticosteroids: Pharmacology', 'Gagandeep Kwatra and Sandip Mukhopadhyay']);
  });

  it('orders a line by position when the producer emits its words out of sequence', () => {
    // "DELTA" is drawn after "RULE" though it sits between "WITH" and "RULE";
    // and the title contains "DELTA", which must not swallow the subtitle's.
    // 20 glyphs of 7pt from x=72 end at 212; DELTA sits at 220..255, RULE after it.
    const a = line('IMPROVING MAMBA WITH', 700, { size: 14 });
    const rule = line('RULE', 700, { x: 262, size: 14 });
    const delta = line('DELTA', 700, { x: 220, size: 14 });
    const chars = [
      ...line('GATED DELTA NETWORKS', 730, { size: 17 }),
      ...a, ...rule, ...delta,
      ...line('Body text of the abstract, long enough to be body text here.', 670),
      ...line('And a second body line to settle the body size of the page.', 656),
    ];
    const r = layoutDocument({ ...OPTS, pages: [page(1, chars)] });
    expect(r.title).toBe('GATED DELTA NETWORKS');
    expect(r.markdown).toContain('\n## IMPROVING MAMBA WITH DELTA RULE\n');
  });

  it('a small-caps heading is a heading: its capitals are set larger than the rest', () => {
    const chars = [
      ...line('A Report Title', 730, { size: 18 }),
      ...line('1 I', 700, { size: 12 }),
      ...line('NTRODUCTION', 700, { x: 72 + 3 * 6, size: 9.6 }),
      ...line('Body text under the small-caps heading, long enough to be body.', 680),
      ...line('And a second body line to settle the body size of the page.', 666),
    ];
    const r = layoutDocument({ ...OPTS, pages: [page(1, chars)] });
    expect(r.sections.map((s) => s.heading)).toEqual(['A Report Title', '1 INTRODUCTION']);
  });

  it('a heading wrapped over two adjacent lines is one heading', () => {
    const chars = [
      ...line('A Report Title', 730, { size: 18 }),
      ...line('2.1 Structure-Activity', 700, { size: 13 }),
      ...line('Relationship', 685, { size: 13 }),
      ...line('Body text under the wrapped heading, long enough to be body text.', 665),
      ...line('And a second body line to settle the body size of the page.', 651),
      ...line('2.2 Potency', 620, { size: 13 }),
      ...line('More body text under the second heading of the page here.', 602),
    ];
    const r = layoutDocument({ ...OPTS, pages: [page(1, chars)] });
    expect(r.sections.map((s) => s.heading)).toEqual(['A Report Title', '2.1 Structure-Activity Relationship', '2.2 Potency']);
    expect(r.markdown).toContain('\n## 2.1 Structure-Activity Relationship\n');
    expect(r.markdown).not.toMatch(/^## Relationship$/m);
  });
});

describe('pages, counts and the page map', () => {
  it('records one span per page, contiguous across pages, and the per-page counts', () => {
    const p1 = page(1, [...line('Page one body text.', 700)], { images: [{ index: 0, bbox: [72, 300, 372, 500] }], pathObjects: 3 });
    const p2 = page(2, [...line('Page two body text.', 700)]);
    const r = layoutDocument({ ...OPTS, pages: [p1, p2] });
    expect(r.pages.map((p) => [p.page, p.chars, p.imageObjects, p.pathObjects])).toEqual([[1, 19, 1, 3], [2, 19, 0, 0]]);
    expect(r.pages[1].startLine).toBe(r.pages[0].endLine + 1);
    const total = r.markdown.split('\n').length;
    expect(r.pages[1].endLine).toBe(total);
  });

  it('emits a note for a page with no characters and counts zero chars', () => {
    const r = layoutDocument({ ...OPTS, pages: [page(1, [], { images: [{ index: 0, bbox: [0, 0, 612, 792] }] })] });
    expect(r.markdown).toContain('*[page 1: no extractable text — scanned image]*');
    expect(r.pages[0].chars).toBe(0);
    expect(r.pages[0].imageObjects).toBe(1);
  });

  it('stops extracting text past the page cap, says so, and marks the result truncated', () => {
    const pages = [1, 2, 3].map((n) => page(n, line(`Text of page ${n}.`, 700), { textExtracted: n <= 2 }));
    const r = layoutDocument({ ...OPTS, maxTextPages: 2, pages });
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain('*[pages 3–3 not extracted: page limit]*');
    expect(r.markdown).not.toContain('Text of page 3.');
    expect(r.pages).toHaveLength(3);
  });
});

describe('figures and captions', () => {
  it('keeps an image object as a figure when it is large enough, anchored to a nearby caption line', () => {
    const chars = [
      ...line('Some text above the figure.', 700),
      ...line('Figure 1. The green rectangle.', 280),
    ];
    const p = page(1, chars, { images: [{ index: 3, bbox: [72, 300, 372, 500] }, { index: 4, bbox: [500, 700, 520, 720] }] });
    const r = layoutDocument({ ...OPTS, pages: [p] });
    expect(r.figures).toEqual([{ page: 1, index: 3, bbox: [72, 300, 372, 500], caption: 'Figure 1. The green rectangle.' }]);
    expect(r.pages[0].imageObjects).toBe(2);
  });

  it('falls back to the structure tree alt text when no caption line is near', () => {
    const p = page(1, line('Unrelated text far away.', 750), {
      images: [{ index: 0, bbox: [72, 100, 372, 300], altText: 'A chart of cells per image' }],
    });
    const r = layoutDocument({ ...OPTS, pages: [p] });
    expect(r.figures[0].caption).toBe('A chart of cells per image');
  });
});

describe('a tagged page', () => {
  it('takes heading levels from structure roles, emits a tagged table as a pipe table, and reports coverage', () => {
    const roles = new Map<number, string>([[0, 'H1'], [1, 'H2'], [2, 'P'], [3, 'TH'], [4, 'TH'], [5, 'TD'], [6, 'TD'], [7, 'P']]);
    const chars = [
      ...line('A Tagged Paper', 720, { size: 18, mcid: 0 }),
      ...line('Results', 690, { size: 12, mcid: 1 }),
      ...line('Table 1 reports the values.', 672, { mcid: 2 }),
      ...line('Config', 640, { x: 72, mcid: 3 }), ...line('Cells', 640, { x: 200, mcid: 4 }),
      ...line('baseline', 624, { x: 72, mcid: 5 }), ...line('803', 624, { x: 200, mcid: 6 }),
      ...line('Closing paragraph.', 590, { mcid: 7 }),
    ];
    const p = page(1, chars, {
      struct: {
        roleByMcid: roles,
        tables: [{ mcids: [3, 4, 5, 6], rows: [{ cells: [{ mcids: [3] }, { mcids: [4] }] }, { cells: [{ mcids: [5] }, { mcids: [6] }] }] }],
        figures: 0,
      },
    });
    const r = layoutDocument({ ...OPTS, title: 'A Tagged Paper', pages: [p] });
    expect(r.tagged).toBe(true);
    expect(r.structCoverage).toBeGreaterThanOrEqual(0.9);
    // H1 equals the title: emitted once as the title, not again as a heading.
    expect(r.markdown.match(/A Tagged Paper/g)).toHaveLength(1);
    expect(r.markdown).toContain('\n### Results\n');
    expect(r.markdown).toContain('| Config | Cells |\n| --- | --- |\n| baseline | 803 |');
    expect(r.tables).toHaveLength(1);
    expect(r.pages[0].taggedTables).toBe(1);
    expect(r.sections.find((s) => s.heading === 'Results')?.origin).toBe('struct');
  });
});

describe('bookmarks', () => {
  it('takes a heading\'s path from the bookmark chain when a bookmark matches it', () => {
    const chars = [
      ...line('Doc', 720, { size: 18 }),
      ...line('Methods', 690, { size: 14 }),
      ...line('Body of methods.', 672),
      ...line('Sampling', 640, { size: 12 }),
      ...line('Body of sampling.', 622),
    ];
    const bookmarks = [
      { title: 'Methods', page: 1, level: 0 },
      { title: 'Sampling', page: 1, level: 1 },
    ];
    const r = layoutDocument({ ...OPTS, bookmarks, pages: [page(1, chars)] });
    const s = r.sections.find((x) => x.heading === 'Sampling')!;
    expect(s.path).toBe('Methods > Sampling');
    expect(s.origin).toBe('bookmark');
  });
});
