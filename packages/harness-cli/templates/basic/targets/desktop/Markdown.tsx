/**
 * Renders a report as GitHub-flavored markdown — headings, lists, tables, links,
 * code. Two pure-JS deps (`react-markdown` + `remark-gfm`); the editorial
 * typography lives in `app.css` under the `.md` class.
 *
 * `h2`/`h3` get slug ids so the Contents (TOC) can link to them, and links open
 * in the system browser via `target="_blank"` (on desktop the Electron main
 * routes it to the OS browser) — the window never navigates away.
 */
import { memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { slugify } from "../../harness/state.js";

/** Flatten a heading's children to text, for the anchor slug. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  h2: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slugify(textOf(children))}>{children}</h3>,
};

function MarkdownInner({ text }: { text: string }): ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}

/** Memoized so streaming re-renders elsewhere don't re-parse a long report. */
export const Markdown = memo(MarkdownInner);
