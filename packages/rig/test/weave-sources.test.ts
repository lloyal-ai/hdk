/**
 * The citation weave, both halves. A report's grammar-forced sources are woven into its findings at capture
 * (the first); a settled answer that cites by number, with its links only in the trailing list, has those
 * numbers made into the links they stand for (the second) — so what the reader sees is a link either way,
 * whichever form the model chose.
 */
import { describe, it, expect } from 'vitest';
import { weaveSourcesIntoResult, weaveOrdinalCitations } from '../src/tools/weave-sources';

describe('weaveSourcesIntoResult', () => {
  it('wraps each bare url with its title, leaves one already linked alone, and appends the list', () => {
    const out = weaveSourcesIntoResult('See https://a.io/x and [done](https://b.io).', [
      { title: 'A', url: 'https://a.io/x' }, { title: 'B', url: 'https://b.io' },
    ]);
    expect(out).toContain('See [A](https://a.io/x) and [done](https://b.io).');
    expect(out).toMatch(/Sources:\n- \[A\]\(https:\/\/a\.io\/x\)\n- \[B\]\(https:\/\/b\.io\)$/);
  });
});

describe('weaveOrdinalCitations', () => {
  const list = '\n\n## Sources\n\n- [First](https://one.io/a)\n- [Second](https://two.io/b)\n';

  it('a bare [n] becomes a link to the nth entry of the trailing list; the list stays', () => {
    const out = weaveOrdinalCitations(`A claim [1]. Another [2].${list}`);
    expect(out).toContain('A claim [1](https://one.io/a). Another [2](https://two.io/b).');
    expect(out).toContain('- [First](https://one.io/a)');
  });

  it('leaves alone what is already a link — markdown, or an anchor already made one — a reference-style definition, and a number the list does not have', () => {
    const body = `Linked [1](https://x.io). Anchored <a href="https://y.io">[2]</a>. Defined [2]: note. Beyond [9].${list}`;
    const out = weaveOrdinalCitations(body);
    expect(out).toContain('Linked [1](https://x.io).');
    expect(out).toContain('Anchored [2](https://y.io).');   // the anchor's own url, never the list's second entry
    expect(out).toContain('Defined [2]: note.');
    expect(out).toContain('Beyond [9].');
  });

  it('an HTML anchor becomes the markdown link it means — the renderer draws markdown links and nothing else', () => {
    const body = 'See <a href="https://y.io/p">the page</a> and <a href=\'https://z.io\' target="_blank">[2]</a>.\n\n## Sources\n\n- [P](https://y.io/p)\n- [Z](https://z.io)';
    const out = weaveOrdinalCitations(body);
    expect(out).toContain('See [the page](https://y.io/p) and [2](https://z.io).');
    expect(out).not.toContain('<a ');
  });

  it('a list entry whose url carries parentheses is read whole — a Wikipedia title is a common one', () => {
    const body = 'The film [1].\n\n## Sources\n\n- [Alien (film)](https://en.wikipedia.org/wiki/Alien_(film))';
    expect(weaveOrdinalCitations(body)).toContain('The film [1](https://en.wikipedia.org/wiki/Alien_(film)).');
  });

  it('a bracketed number inside code — a span or a fence — is code, not a citation, and is left alone', () => {
    const body = 'Read `items[1]` then [1].\n\n```js\nconst x = list[2];\n```\n\nAlso [2].' + list;
    const out = weaveOrdinalCitations(body);
    expect(out).toContain('Read `items[1]` then [1](https://one.io/a).');
    expect(out).toContain('const x = list[2];');
    expect(out).toContain('Also [2](https://two.io/b).');
    // Every CommonMark spelling of code: a double-backtick span, a longer fence, a tilde fence.
    const more = 'A ``pair[1]`` then [1].\n\n````\nfour[2]\n````\n\n~~~py\ntilde[1]\n~~~\n\nAlso [2].' + list;
    const woven = weaveOrdinalCitations(more);
    expect(woven).toContain('A ``pair[1]`` then [1](https://one.io/a).');
    expect(woven).toContain('four[2]\n');
    expect(woven).toContain('tilde[1]\n');
    expect(woven).toContain('Also [2](https://two.io/b).');
  });

  it('an HTML anchor inside code is a literal example, and stays byte for byte — a fenced html block, a span', () => {
    const body = 'Write `<a href="https://x.io">[1]</a>` or:\n\n```html\n<a href="https://y.io">the page</a> [2]\n```\n\nThen see [1].' + list;
    const out = weaveOrdinalCitations(body);
    expect(out).toContain('Write `<a href="https://x.io">[1]</a>` or:');
    expect(out).toContain('```html\n<a href="https://y.io">the page</a> [2]\n```');
    expect(out).toContain('Then see [1](https://one.io/a).');
  });

  it('a number the body DEFINES as a reference is already a link — it keeps its own url, whatever the trailing list says', () => {
    const body = 'Claim [1]. Another [2].\n\n[1]: https://original.io\n\n## Sources\n\n- [Other](https://other.io)\n- [Second](https://two.io/b)';
    const out = weaveOrdinalCitations(body);
    expect(out).toContain('Claim [1]. Another [2](https://two.io/b).');
    expect(out).toContain('[1]: https://original.io');
  });

  it('a body with no trailing list, or no bare number, is returned unchanged', () => {
    expect(weaveOrdinalCitations('Nothing to do [1].')).toBe('Nothing to do [1].');
    expect(weaveOrdinalCitations(`No numbers here.${list}`)).toBe(`No numbers here.${list}`);
  });

  it('the list is read in its own order, under any of the headings a model writes, and a numbered list counts the same', () => {
    const numbered = 'Claim [2] and [1].\n\nSources:\n1. [One](https://one.io)\n2. [Two](https://two.io)';
    expect(weaveOrdinalCitations(numbered)).toContain('Claim [2](https://two.io) and [1](https://one.io).');
    const refs = 'Claim [1].\n\n**References**\n- [Only](https://only.io)';
    expect(weaveOrdinalCitations(refs)).toContain('Claim [1](https://only.io).');
    // The colon on either side of the closing emphasis, and a heading that is itself bold.
    for (const head of ['**Sources:**', '**Sources**:', '## **Sources**', '### Sources:']) {
      expect(weaveOrdinalCitations(`Claim [1].\n\n${head}\n- [Only](https://only.io)`), head).toContain('Claim [1](https://only.io).');
    }
  });
});
