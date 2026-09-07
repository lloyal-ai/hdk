/**
 * Chunking utilities for web page content
 *
 * Two strategies:
 * - {@link chunkHtml} — structural splitting on HTML headings/paragraphs
 *   via linkedom. Used by FetchPageTool for per-tool reranking.
 * - {@link chunkFetchedPages} — plain-text `\n\n` splitting for buffered
 *   content. Used for post-research passage reranking.
 *
 * @packageDocumentation
 * @category Rig
 */

import type { Chunk } from '../resources/types';
import { splitParagraphs } from '../resources/fit';

/**
 * Raw page content buffered during web research for post-research reranking
 *
 * Populated by {@link BufferingFetchPage} as agents fetch pages. After
 * the research phase ends, buffered pages are converted to {@link Chunk}
 * instances via {@link chunkFetchedPages} for reranker scoring.
 *
 * @category Rig
 */
export interface FetchedPage {
  /** Resolved URL of the fetched page */
  url: string;
  /** Page title extracted during fetch (may be empty) */
  title: string;
  /** Full extracted article text */
  text: string;
}

/**
 * Convert buffered web pages into {@link Chunk} instances for reranking
 *
 * Splits each page's text on blank-line paragraph boundaries, filtering
 * paragraphs shorter than 40 characters. If no paragraphs survive the
 * filter, the full text is emitted as a single chunk (if long enough).
 *
 * @param pages - Buffered pages from web research
 * @returns Flat array of paragraph-level chunks with `tokens` arrays left empty for later tokenization
 *
 * @category Rig
 */
export function chunkFetchedPages(pages: FetchedPage[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const page of pages) {
    // Real line ranges over the page text: a consumer holding the same text can
    // resolve any chunk, and windows over these chunks keep distinct start lines.
    const lines = page.text.split('\n');
    const before = chunks.length;
    for (const [start, end] of splitParagraphs(lines)) {
      const text = lines.slice(start, end).join('\n').trim();
      if (text.length <= 40) continue;
      chunks.push({
        resource: page.url,
        heading: page.title || page.url,
        section: '',
        text,
        tokens: [],
        startLine: start + 1,
        endLine: end,
      });
    }
    if (chunks.length === before && page.text.trim().length > 40) {
      chunks.push({
        resource: page.url,
        heading: page.title || page.url,
        section: '',
        text: page.text.trim(),
        tokens: [],
        startLine: 1,
        endLine: lines.length,
      });
    }
  }
  return chunks;
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const TEXT_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'FIGCAPTION', 'DT', 'DD']);

/**
 * Split article HTML into heading-delimited section chunks via linkedom
 *
 * Same structural strategy as `parseMarkdown` (md4c) uses for corpus files:
 * headings are section boundaries, content between headings is accumulated
 * into a single chunk with the heading as metadata.
 *
 * Falls back to `<p>`-level chunks for pages without headings.
 *
 * @param html - Article HTML from Readability's `article.content`
 * @param url - Page URL (used as chunk `resource`)
 * @param title - Page title (used as default heading)
 * @returns Array of section-level chunks
 *
 * @category Rig
 */
export async function chunkHtml(html: string, url: string, title: string): Promise<Chunk[]> {
  const { parseHTML } = await import('linkedom');
  const { document } = parseHTML(html);

  const chunks: Chunk[] = [];
  let currentHeading = title;
  let currentText = '';
  // Real line ranges over the text this function builds: the emitted sections
  // joined by one blank line. Distinct start lines per chunk, contiguous
  // ranges, and a line count that matches each chunk's text.
  let cursor = 0;

  function flushSection() {
    const text = currentText.trim();
    if (text.length > 40) {
      if (chunks.length > 0) cursor += 1;
      const startLine = cursor + 1;
      const endLine = cursor + text.split('\n').length;
      cursor = endLine;
      chunks.push({
        resource: url,
        heading: currentHeading || title || url,
        section: '',
        text,
        tokens: [],
        startLine,
        endLine,
      });
    }
    currentText = '';
  }

  // Walk all elements in the article DOM
  const elements = document.querySelectorAll('*');
  for (const el of elements) {
    const tag = el.tagName;

    if (HEADING_TAGS.has(tag)) {
      // Close current section, start new one with this heading
      flushSection();
      currentHeading = el.textContent?.trim() || title;
    } else if (TEXT_TAGS.has(tag)) {
      // Accumulate text content — skip if this element is nested inside
      // another TEXT_TAG (avoid double-counting nested <li> etc.)
      const parentTag = el.parentElement?.tagName;
      if (parentTag && TEXT_TAGS.has(parentTag)) continue;

      const text = el.textContent?.trim();
      if (text) {
        currentText += (currentText ? '\n\n' : '') + text;
      }
    }
  }

  // Flush final section
  flushSection();

  return chunks;
}
