/**
 * Markdown in a harness view: GitHub-flavoured, with math set by KaTeX, links
 * left to the caller's renderers, and the content plane's own scheme admitted
 * through the URL transform so a cited page (`attachment://…/page/n`) reaches
 * the caller's link component instead of being stripped as unknown.
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
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

export type { Components as MarkdownComponents } from 'react-markdown';

const MATH = `
  .katex { font-size: 1em !important; }
  .katex, .katex *:not(.delimsizing, .op-symbol) { font-family: inherit !important; }
  .katex :is(.mfrac, .sqrt, .root, .accent) * {
    font-family: KaTeX_Main, "Times New Roman", serif !important;
  }
`;

/** The content plane's scheme is admitted; every other unknown scheme is stripped, as react-markdown does. */
export const admitAttachmentUrls = (url: string): string =>
  url.startsWith('attachment://') ? url : defaultUrlTransform(url);

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
        urlTransform={admitAttachmentUrls}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
