/**
 * The generic agent fold: an agent's life on a view, from the bus events every
 * pool emits, with the application deciding only what a spawn is for.
 */
import { describe, it, expect } from 'vitest';
import { foldAgents, emptyRoster, extractStreamingReport, summarizeResult } from '../src/fold';
import type { AgentEvent, AgentRoster, FoldAgentsOptions } from '../src/fold';

const now = () => 1000;
const research = { spawn: () => ({ taskIndex: 0, taskDescription: 'look' }), terminal: 'report', now };
const fold = (r: AgentRoster, evs: AgentEvent[], opts: FoldAgentsOptions = research): AgentRoster => evs.reduce((acc, ev) => foldAgents(acc, ev, opts), r);
const spawn = (agentId: number): AgentEvent => ({ type: 'agent:spawn', agentId });
const produce = (agentId: number, text: string, tokenCount: number): AgentEvent => ({ type: 'agent:produce', agentId, text, tokenCount });

describe('foldAgents', () => {
  it('a spawn the application gives a task opens a live think block; one it does not is tracked silently', () => {
    const r = fold(emptyRoster(), [spawn(1)]);
    const a = r.agents.get(1)!;
    expect(a.label).toBe('A0');
    expect(a.phase).toBe('thinking');
    expect(a.timeline).toEqual([{ kind: 'think', id: 0, title: 'Thinking…', body: '', live: true, openedAt: 1000, closedAt: null }]);
    const s = fold(emptyRoster(), [spawn(7)], { now });
    expect(s.agents.get(7)!.phase).toBe('idle');
    expect(s.agents.get(7)!.timeline).toEqual([]);
    expect(s.agents.get(7)!.taskIndex).toBeNull();
  });

  it('a think block advances until </think>, then closes with a title and seeds the content buffer with the tail', () => {
    const r = fold(emptyRoster(), [spawn(1), produce(1, 'The plan is ', 3), produce(1, 'simple.</think><tool_call>', 8)]);
    const a = r.agents.get(1)!;
    const think = a.timeline[0];
    expect(think.kind === 'think' && think.body).toBe('The plan is simple.');
    expect(think.kind === 'think' && think.title).toBe('The plan is simple.');
    expect(think.kind === 'think' && think.live).toBe(false);
    expect(a.phase).toBe('content');
    expect(a.contentBuffer).toBe('<tool_call>');
    expect(a.tokenCount).toBe(8);
  });

  it('a tool call closes the think, adds a row with its argument summary; the result pairs with it and reopens thinking', () => {
    const r = fold(emptyRoster(), [
      spawn(1), produce(1, 'x</think>', 1),
      { type: 'agent:tool_call', agentId: 1, tool: 'web_search', args: JSON.stringify({ query: 'continuous batching' }) },
      { type: 'agent:tool_result', agentId: 1, tool: 'web_search', result: JSON.stringify([{ url: 'https://a.io/x', title: 'A' }]) },
      produce(1, 'next', 5),
    ]);
    const a = r.agents.get(1)!;
    expect(a.timeline.map((t) => t.kind)).toEqual(['think', 'tool_call', 'tool_result', 'think']);
    const call = a.timeline[1];
    expect(call.kind === 'tool_call' && call.argsSummary).toBe('"continuous batching"');
    const result = a.timeline[2];
    expect(result.kind === 'tool_result' && result.callId).toBe(call.id);
    expect(result.kind === 'tool_result' && result.hosts).toEqual(['a.io']);
    expect(result.kind === 'tool_result' && result.sources?.[0]?.host).toBe('a.io');
    expect(a.toolCallCount).toBe(1);
    expect(a.phase).toBe('thinking');
  });

  it('a terminal whose text lives in another argument streams from that argument, when the application names it', () => {
    const rows = { spawn: () => ({ taskIndex: 0 }), terminal: 'enrich_row', terminalField: 'summary', now };
    const streamed = '<tool_call>\n<function=enrich_row>\n<parameter=summary>\nA row';
    const r = [
      spawn(1), produce(1, 'x</think>', 1), produce(1, streamed, 4),
      { type: 'agent:tool_call' as const, agentId: 1, tool: 'enrich_row', args: '{}' },
    ].reduce((acc, ev) => foldAgents(acc, ev, rows), emptyRoster());
    expect(r.agents.get(1)!.timeline.filter((t) => t.kind === 'tool_call')).toEqual([]);
    expect(extractStreamingReport(streamed, { tool: 'enrich_row', field: 'summary' })).toBe('A row');
    expect(extractStreamingReport(streamed)).toBeNull();
  });

  it('an ordinary tool that shares the terminal\'s argument name is a step of the work, not a report', () => {
    // `finish(body)` ends the turn; `write_file(body)` is just a tool. The argument name alone cannot tell them apart.
    const rows = { spawn: () => ({ taskIndex: 0 }), terminal: 'finish', terminalField: 'body', now };
    const writing = '<tool_call>\n<function=write_file>\n<parameter=path>\nnotes.md\n</parameter>\n<parameter=body>\nFILE CONTENTS';
    expect(extractStreamingReport(writing, { tool: 'finish', field: 'body' })).toBeNull();
    const r = [
      spawn(1), produce(1, 'x</think>', 1), produce(1, writing, 4),
      { type: 'agent:tool_call' as const, agentId: 1, tool: 'write_file', args: '{"path":"notes.md"}' },
    ].reduce((acc, ev) => foldAgents(acc, ev, rows), emptyRoster());
    expect(r.agents.get(1)!.timeline.filter((t) => t.kind === 'tool_call').map((t) => t.kind === 'tool_call' && t.tool)).toEqual(['write_file']);
    // And the terminal is still the terminal, after an ordinary call in the same buffer's history.
    const finishing = '<tool_call>\n<function=finish>\n<parameter=body>\nTHE FINDINGS';
    expect(extractStreamingReport(finishing, { tool: 'finish', field: 'body' })).toBe('THE FINDINGS');
  });

  it('the terminal tool adds no row — its report streamed as content — and agent:return files the report', () => {
    const r = fold(emptyRoster(), [
      spawn(1), produce(1, 'x</think>', 1), produce(1, '<tool_call><parameter=result>\nFindings', 4),
      { type: 'agent:tool_call', agentId: 1, tool: 'report', args: '{}' },
      { type: 'agent:return', agentId: 1, result: 'Findings' },
    ]);
    const a = r.agents.get(1)!;
    expect(a.timeline.map((t) => t.kind)).toEqual(['think', 'report']);
    expect(a.phase).toBe('done');
    expect(a.endedAt).toBe(1000);
    expect(a.contentBuffer).toBe('');
    expect(extractStreamingReport('<tool_call><parameter=result>\nFindings')).toBe('Findings');
  });

  it('a stall-break done routes the forced recovery into the buffer, and recovered files it as the report', () => {
    const r = fold(emptyRoster(), [
      spawn(1), produce(1, 'thinking', 1),
      { type: 'agent:done', agentId: 1 },
      produce(1, 'What I found: ', 3), produce(1, 'enough.', 5),
      { type: 'agent:recovered', agentId: 1, result: 'What I found: enough.' },
    ]);
    const a = r.agents.get(1)!;
    expect(a.timeline.map((t) => t.kind)).toEqual(['think', 'report']);
    expect(a.recovering).toBe(false);
    expect(a.phase).toBe('done');
    const mid = fold(emptyRoster(), [spawn(1), produce(1, 'thinking', 1), { type: 'agent:done', agentId: 1 }, produce(1, 'What I found', 3)]).agents.get(1)!;
    expect(mid.recovering).toBe(true);
    expect(mid.contentBuffer).toBe('What I found');
  });

  it('a failed agent freezes with its reason; a later done or produce changes nothing but the count', () => {
    const r = fold(emptyRoster(), [spawn(1), produce(1, 'x', 1), { type: 'agent:failed', agentId: 1, reason: 'llama_decode failed' }]);
    const a = r.agents.get(1)!;
    expect(a.phase).toBe('failed');
    expect(a.failReason).toBe('llama_decode failed');
    const after = fold(r, [{ type: 'agent:done', agentId: 1 }, produce(1, 'late', 9)]).agents.get(1)!;
    expect(after.phase).toBe('failed');
    expect(after.tokenCount).toBe(9);
  });

  it('a retry parks the pending call until its result lands', () => {
    const r = fold(emptyRoster(), [
      spawn(1), produce(1, 'x</think>', 1),
      { type: 'agent:tool_call', agentId: 1, tool: 'fetch_page', args: '{"url":"https://a.io"}' },
      { type: 'agent:tool_retry', agentId: 1, tool: 'fetch_page', retryAfterMs: 500, attempt: 1 },
    ]);
    expect(r.agents.get(1)!.retry).toEqual({ tool: 'fetch_page', retryAt: 1500, attempt: 1 });
    const done = fold(r, [{ type: 'agent:tool_result', agentId: 1, tool: 'fetch_page', result: '{"url":"https://a.io","title":"A"}' }]);
    expect(done.agents.get(1)!.retry).toBeNull();
  });

  it('an event for an unknown agent, or one that changes nothing, returns the same roster', () => {
    const r = fold(emptyRoster(), [spawn(1)]);
    expect(foldAgents(r, produce(9, 'x', 1), research)).toBe(r);
    expect(foldAgents(r, { type: 'agent:tool_retry', agentId: 9, tool: 't', retryAfterMs: 1, attempt: 1 }, research)).toBe(r);
  });

  it('labels and timeline ids are stable across agents in one roster', () => {
    const r = fold(emptyRoster(), [spawn(3), spawn(5), produce(3, 'a</think>', 1), { type: 'agent:tool_call', agentId: 3, tool: 'grep', args: '{"pattern":"x"}' }]);
    expect([r.agents.get(3)!.label, r.agents.get(5)!.label]).toEqual(['A0', 'A1']);
    expect(r.agents.get(3)!.timeline.map((t) => t.id)).toEqual([0, 2]);
    expect(r.agents.get(5)!.timeline.map((t) => t.id)).toEqual([1]);
    expect(r.nextTimelineId).toBe(3);
  });

  it('summarizes the stock abilities\' results, and falls back to the URLs a result carries', () => {
    expect(summarizeResult('search', JSON.stringify({ hits: [{ file: 'a.md', heading: 'H' }] })).resultCount).toBe(1);
    expect(summarizeResult('grep', JSON.stringify({ totalMatches: 2, matches: [{ file: 'a.md', line: 3, text: 't' }] })).summary).toBe('2 matches');
    expect(summarizeResult('fetch_page', JSON.stringify({ url: 'https://b.io/p', title: 'B' })).hosts).toEqual(['b.io']);
    expect(summarizeResult('unknown', 'see https://c.io and https://d.io/x').summary).toBe('2 links');
    expect(summarizeResult('unknown', 'plain').summary).toBe('5b');
  });
});
