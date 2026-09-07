/**
 * The web tools' two per-dispatch reads, pinned before they move: peer dedup
 * from `peerHistory`, and the entailment pass that `explore` switches off.
 *
 * @category Testing
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { Trace, NullTraceWriter } from '@lloyal-labs/lloyal-agents';
import type { ToolContext, ToolHistoryEntry } from '@lloyal-labs/lloyal-agents';
import type { SearchProvider } from '@lloyal-labs/rig';
import { WebSearchTool } from '../src/tools/web-search';
import { FetchPageTool } from '../src/tools/fetch-page';

const provider: SearchProvider = {
  search: async () => [
    { title: 'A', url: 'https://a.example/', snippet: 'alpha things', score: 0.9 },
    { title: 'B', url: 'https://b.example/', snippet: 'beta things', score: 0.8 },
    { title: 'C', url: 'https://c.example/', snippet: 'gamma things', score: 0.7 },
  ],
} as unknown as SearchProvider;

const peer = (name: string, args: Record<string, unknown>): ToolHistoryEntry =>
  ({ name, args: JSON.stringify(args), resultCells: 5, contextAfterPercent: 90, timestamp: 0, outcome: 'toolResult' }) as ToolHistoryEntry;

const exec = (tool: WebSearchTool | FetchPageTool, args: Record<string, unknown>, context: Partial<ToolContext>) =>
  run(function* () {
    yield* Trace.set(new NullTraceWriter());
    return (yield* tool.execute(args as never, context as ToolContext)) as Record<string, unknown>;
  });

describe('web tools — peer dedup and the explore switch', () => {
  it('web_search declines a query a sibling already issued, and fetch_page a URL a sibling already fetched', async () => {
    const search = new WebSearchTool(provider);
    const r = await exec(search, { query: 'alpha' }, { peerHistory: [peer('web_search', { query: 'alpha' })] });
    expect(String(r.error ?? r.note ?? '')).toMatch(/Resource unavailable/);
    const fetch = new FetchPageTool();
    const f = await exec(fetch, { url: 'https://a.example/' }, { peerHistory: [peer('fetch_page', { url: 'https://a.example/' })] });
    expect(String(f.error ?? f.note ?? '')).toMatch(/Resource unavailable/);
  });

  it('exploit consults the entailment scorer once and re-ranks by min(); explore never consults it', async () => {
    const calls: string[][] = [];
    const scorer = { scoreEntailmentBatch: async (texts: string[]) => { calls.push(texts); return texts.map((t) => (t.includes('gamma') ? 9 : -9)); } };
    const search = new WebSearchTool(provider);
    const exploit = await exec(search, { query: 'q' }, { explore: false, scorer: scorer as never });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    const first = (exploit as { results?: { url: string }[] }).results?.[0] ?? (Array.isArray(exploit) ? (exploit as { url: string }[])[0] : undefined);
    expect(first?.url).toBe('https://c.example/');
    const explore = await exec(search, { query: 'q' }, { explore: true, scorer: scorer as never });
    expect(calls).toHaveLength(1);
    expect(explore).toBeTruthy();
  });
});
