/**
 * Markdown in a harness view: GitHub-flavoured, with math set by KaTeX, links
 * left to the caller's renderers, and urls admitted by the view's one policy
 * (`admitUrl`, shared with `linksOf`) so a cited page
 * (`attachment://…/page/n`) reaches the caller's link component instead of
 * being stripped as unknown.
 *
 * Math takes the document's own face where that is safe: inline runs inherit
 * the surrounding font, while stacked constructs (fractions, radicals,
 * accents, sized operators and delimiters) keep KaTeX's fonts — its metrics
 * position them, and an inherited face's taller numerals crash into the bar.
 *
 * @category UI
 */
import { memo } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { admitUrl } from './prose.js';

export type { Components as MarkdownComponents } from 'react-markdown';

const MATH = `
  .katex { font-size: 1em !important; }
  .katex, .katex *:not(.delimsizing, .op-symbol) { font-family: inherit !important; }
  .katex :is(.mfrac, .sqrt, .root, .accent) * {
    font-family: KaTeX_Main, "Times New Roman", serif !important;
  }
`;

/** Memoized on its props: a settled block keeps its parse while a sibling streams. */
export const Markdown = memo(function Markdown({ markdown, components, style }: {
  markdown: string;
  /** The caller's renderers — links with citation chips, headings with anchors, the prose's own type. */
  components?: Components;
  style?: CSSProperties;
}): ReactElement {
  return (
    <div style={style}>
      <style>{MATH}</style>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        urlTransform={admitUrl}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
