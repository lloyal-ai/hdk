/**
 * Scenario: the framework repairs only what it captured itself.
 *
 * A trailing unclosed `<tool_call>` fragment is stripped from a result the
 * FRAME captured (the default capture of a terminal call: a truncated call
 * must not ride into another prompt as a demonstration). A result a TOOL's own
 * `onReturn` captured is the tool's bytes: typed data may legitimately contain
 * the marker — a program that prints it — and only the capture knows which of
 * its strings is prose. Both paths: the voluntary return and the recovery.
 *
 * What this locks:
 *   - `apply.ts` strips iff `decideOnReturn` says `by === 'frame'`.
 *   - A contributor's accept reaches `agent.result` byte for byte.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import { Tool } from '../../../src/Tool';
import type { ToolLifecycleHooks } from '../../../src/Tool';
import type { JsonSchema } from '../../../src/types';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

const PROGRAM = 'const opening = "<tool_call>";\nconsole.log(opening);\n';
const TRUNCATED = 'Findings so far.\n\n<tool_call>\n{"name": "web_se';

/** A terminal that captures its `source` argument as the agent's result, byte for byte. */
class Finish extends Tool<{ source: string }> {
  readonly name = 'finish';
  readonly description = 'hand in a program';
  readonly parameters: JsonSchema = { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] };
  readonly hooks: ToolLifecycleHooks = { onReturn: ({ args }) => ({ type: 'accept', result: String(args.source) }) };
  *execute(): Operation<unknown> { throw new Error('terminal'); }
}
/** A terminal with no capture of its own: the frame's default reads `.result`. */
class Report extends Tool<{ result: string }> {
  readonly name = 'report';
  readonly description = 'report';
  readonly parameters: JsonSchema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] };
  *execute(): Operation<unknown> { throw new Error('terminal'); }
}
const only = (t: Tool) => new Map<string, Tool>([[t.name, t]]);

describe('scenario: a capture keeps its bytes', () => {
  it("a tool's own capture reaches agent.result byte for byte — the marker inside a program survives the voluntary return", async () => {
    const r = await runPool({
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'finish', arguments: JSON.stringify({ source: PROGRAM }) } }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'finish' }),
      tools: only(new Finish()), terminalToolName: 'finish',
    });
    expect(r.result.agents[0].result).toBe(PROGRAM);
  });

  it("the frame's default capture is repaired: a truncated call trailing a report is stripped on the voluntary return", async () => {
    const r = await runPool({
      scripts: [{ tokens: [1, STOP], toolCall: { name: 'report', arguments: JSON.stringify({ result: TRUNCATED }) } }],
      policy: new DefaultAgentPolicy({ terminalToolName: 'report' }),
      tools: only(new Report()), terminalToolName: 'report',
    });
    expect(r.result.agents[0].result).toBe('Findings so far.');
  });

  it('the same two rules hold on the recovery path', async () => {
    // Main turn: free text with no result (idle) → reaped → the recovery turn is the terminal call.
    const recovering = (tool: string, args: Record<string, string>) => ({
      tokens: [1, STOP, 2, STOP], content: 'prose, no call', toolCall: { name: tool, arguments: JSON.stringify(args) },
    });
    const policy = (terminal: string) => new DefaultAgentPolicy({
      terminalToolName: terminal,
      recovery: { prompt: () => ({ systemPrompt: 's', content: 'u' }), minTokens: 0, minToolCalls: 0 },
    });
    // The main turn parses as the content (no call); the recovery turn parses as the call.
    const parseByTurn = (ctx: { parseChatOutput: unknown; tokenToText: (t: number) => string }, tool: string, args: Record<string, string>) => {
      ctx.parseChatOutput = ((raw: string, _f: unknown, opts?: { isPartial?: boolean }) => {
        if (opts?.isPartial) return { content: '', reasoningContent: '', toolCalls: [] };
        if (raw.includes('t2')) return { content: '', reasoningContent: '', toolCalls: [{ id: 'c1', name: tool, arguments: JSON.stringify(args) }] };
        return { content: 'prose, no call', reasoningContent: '', toolCalls: [] };
      }) as typeof ctx.parseChatOutput;
    };
    const kept = await runPool({
      scripts: [recovering('finish', { source: PROGRAM })], policy: policy('finish'), tools: only(new Finish()), terminalToolName: 'finish',
      instrument: (ctx) => parseByTurn(ctx, 'finish', { source: PROGRAM }),
    });
    expect(kept.channelEvents.some((e) => e.type === 'agent:recovered')).toBe(true);
    expect(kept.result.agents[0].result).toBe(PROGRAM);

    const repaired = await runPool({
      scripts: [recovering('report', { result: TRUNCATED })], policy: policy('report'), tools: only(new Report()), terminalToolName: 'report',
      instrument: (ctx) => parseByTurn(ctx, 'report', { result: TRUNCATED }),
    });
    expect(repaired.channelEvents.some((e) => e.type === 'agent:recovered')).toBe(true);
    expect(repaired.result.agents[0].result).toBe('Findings so far.');
  });
});
