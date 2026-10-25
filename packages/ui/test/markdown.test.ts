/**
 * The renderer draws what `linksOf` reports: a bare attachment address in prose reaches the caller's link
 * component as a link, so a harness renders a cited moment or page the same however the model wrote it.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/markdown';

describe('Markdown', () => {
  it('hands a bare attachment address to the link renderer, once, with the sentence\'s punctuation left out', () => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      markdown: 'It brakes at attachment://81cc8d9fd4e4/t/1m24.87s. [again](attachment://81cc8d9fd4e4/t/1m24.87s)',
      components: { a: ({ href, children }) => createElement('a', { 'data-cited': href }, children) },
    }));
    expect(html.match(/data-cited="attachment:\/\/81cc8d9fd4e4\/t\/1m24\.87s"/g)).toHaveLength(2);
    expect(html).toContain('>attachment://81cc8d9fd4e4/t/1m24.87s</a>.');
  });
});
