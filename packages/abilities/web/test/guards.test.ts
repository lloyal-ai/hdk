/**
 * The web ability's gates: what each refuses, normalised the way its tool
 * normalises, and that the tools declare them. Scope is not tested here — a
 * gate reads whatever `attended()` the pool hands it, and the pool's scoping
 * is the framework's (`hooks.test.ts` in agents).
 */
import { describe, it, expect } from 'vitest';
import type { GuardInput } from '@lloyal-labs/lloyal-agents';
import { urlDedup, queryDedup, trimmed } from '../src/tools/guards';
import { FetchPageTool } from '../src/tools/fetch-page';
import { WebSearchTool } from '../src/tools/web-search';
import type { SearchProvider } from '../src/tools/web-search';
import { WebSource } from '../src/source';

/** A call as a gate sees it, over the arguments this scope already attended. */
const seen = (tool: string, args: Record<string, unknown>, attended: Record<string, unknown>[]): GuardInput =>
  ({ tool, args, attended: () => attended });

describe("url_dedup — fetch_page's gate", () => {
  const page = { url: 'https://example.com/a' };

  it('refuses a URL already attended', () => {
    expect(urlDedup.reject(seen('fetch_page', page, [page]))).toBe(true);
  });

  it('admits a URL not yet attended', () => {
    expect(urlDedup.reject(seen('fetch_page', { url: 'https://example.com/b' }, [page]))).toBe(false);
  });

  it('trims the way the tool trims: a whitespace-only variant is the same resource, on either side', () => {
    expect(urlDedup.reject(seen('fetch_page', { url: '  https://example.com/a  ' }, [page]))).toBe(true);
    expect(urlDedup.reject(seen('fetch_page', page, [{ url: ' https://example.com/a ' }]))).toBe(true);
  });

  it('keeps case, as the tool fetches it', () => {
    expect(urlDedup.reject(seen('fetch_page', { url: 'https://example.com/A' }, [page]))).toBe(false);
  });

  it('a call with no url, or a blank one, is not a duplicate of anything', () => {
    expect(urlDedup.reject(seen('fetch_page', {}, [page]))).toBe(false);
    expect(urlDedup.reject(seen('fetch_page', { url: '   ' }, [{ url: '' }]))).toBe(false);
  });

  it('is published under its name, with the message the model reads', () => {
    expect(urlDedup.name).toBe('url_dedup');
    expect(urlDedup.message).toBe('This URL was already attempted in this run. Try a different source.');
  });
});

describe("query_dedup — web_search's gate", () => {
  const q = { query: 'same query' };

  it('refuses a query already attended', () => {
    expect(queryDedup.reject(seen('web_search', q, [q]))).toBe(true);
  });

  it('folds case and trims: "  Same Query " is the same search, on either side', () => {
    expect(queryDedup.reject(seen('web_search', { query: '  Same Query ' }, [q]))).toBe(true);
    expect(queryDedup.reject(seen('web_search', q, [{ query: 'SAME QUERY' }]))).toBe(true);
  });

  it('admits a refined query', () => {
    expect(queryDedup.reject(seen('web_search', { query: 'same query, 2026' }, [q]))).toBe(false);
  });

  it('a call with no query, or a blank one, is not a duplicate of anything', () => {
    expect(queryDedup.reject(seen('web_search', {}, [q]))).toBe(false);
    expect(queryDedup.reject(seen('web_search', { query: ' ' }, [{ query: '' }]))).toBe(false);
  });

  it('is published under its name, with the message the model reads', () => {
    expect(queryDedup.name).toBe('query_dedup');
    expect(queryDedup.message).toBe('This search was already attempted in this run. Refine the query or report your findings.');
  });
});

describe('the tools declare their gates', () => {
  it('fetch_page declares url_dedup; web_search declares query_dedup', () => {
    expect(new FetchPageTool().hooks.beforeDispatch).toEqual([urlDedup]);
    const provider: SearchProvider = { returnsFullContentMarkdown: false, search: async () => [] };
    expect(new WebSearchTool(provider).hooks.beforeDispatch).toEqual([queryDedup]);
  });

  it("the source's buffering fetch_page inherits the declaration", () => {
    const provider: SearchProvider = { returnsFullContentMarkdown: false, search: async () => [] };
    const fetchPage = new WebSource(provider).tools.find((t) => t.name === 'fetch_page')!;
    expect(fetchPage.hooks?.beforeDispatch).toEqual([urlDedup]);
  });

  it('trimmed() is the normalisation the tools themselves apply', () => {
    expect(trimmed('  x ')).toBe('x');
    expect(trimmed('')).toBe('');
    expect(trimmed(3)).toBeUndefined();
    expect(trimmed(undefined)).toBeUndefined();
  });
});
