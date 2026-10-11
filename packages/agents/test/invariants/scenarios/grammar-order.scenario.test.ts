/**
 * How a branch samples under a tool's grammar is the tool's to declare, and the pool applies it at the one
 * moment it learns which tool is being called.
 *
 * A grammar is attached per turn and masks the whole vocabulary before the sampler picks: exact, and a walk
 * over every vocabulary entry per token. A tool whose arguments are mostly prose (a report) declares
 * `grammarOrder: 'sampleFirst'`; the pool flips the branch the moment its observe step identifies the call
 * as that tool, so the envelope and the name were masked and the document is not. A tool that declares
 * nothing is never flipped. An extracting agent, given the terminal tool's grammar alone, gets the terminal
 * tool's order with the attach.
 *
 * Locks: the flip follows identification (never before a token, never twice per attach), it is the
 * declaration that decides (not the tool's name, not its being terminal), and recovery honours the
 * terminal tool's declaration.
 */
import { describe, it, expect } from 'vitest';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { Tool } from '../../../src/Tool';
import { GrammarTriggerType } from '@lloyal-labs/sdk';
import type { GrammarOrder } from '@lloyal-labs/sdk';
import { runPool, STOP } from '../harness';
import type { InstrumentedMockSessionContext } from '../harness';
import { I44_sampleFirstFollowsIdentification } from '../predicates';

class Declared extends Tool<Record<string, unknown>> {
  readonly parameters = { type: 'object', properties: {} };
  constructor(readonly name: string, readonly grammarOrder?: GrammarOrder) { super(); }
  readonly description = 'a tool';
  *execute(): Operation<unknown> { return { ok: true }; }
}

const tools = () => new Map<string, Tool>([
  ['report', new Declared('report', 'sampleFirst')],
  ['search', new Declared('search')],
]);

/** The agent's turn ends as a free-text stop; the partial parse names the tool from its first token. */
const idle: AgentPolicy = {
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  shouldExit: () => false,
};

/** The scripted model formats no grammar; give it the shape a tool-calling template returns, a lazy grammar
 *  with a trigger word, so the pool attaches one per turn and the terminal grammar exists for recovery. */
const withGrammar = (ctx: InstrumentedMockSessionContext) => {
  const format = ctx.formatChatSync.bind(ctx);
  ctx.formatChatSync = (msgs, opts) => ({
    ...format(msgs, opts),
    grammar: 'root ::= "<tool_call>" [^<]* "</tool_call>"',
    grammarLazy: true,
    grammarTriggers: [{ type: GrammarTriggerType.WORD, value: '<tool_call>', token: -1 }],
  });
};

const orders = (events: { kind: string; handle: number; sampleFirst?: boolean }[]) =>
  events.filter((e): e is { kind: 'order'; handle: number; sampleFirst: boolean } => e.kind === 'order');

describe('scenario: the tool declares how its grammar is sampled', () => {
  it('flips the branch to sample-first once the call is identified as a tool that declares it', async () => {
    const run = await runPool({
      nCtx: 4096, cellsUsed: 0, tools: tools(), terminalToolName: 'report', policy: idle, instrument: withGrammar,
      scripts: [{ tokens: [1, 2, 3, STOP], partialToolCall: { name: 'report', arguments: '{}' }, content: 'done' }],
    });
    const flips = orders(run.grammarEvents);
    expect(flips).toHaveLength(1);
    expect(flips[0].sampleFirst).toBe(true);
    // The flip came after the first sample under the turn's grammar, never before a token existed.
    const attach = run.grammarEvents.findIndex(e => e.kind === 'attach' && e.handle === flips[0].handle);
    const firstSample = run.grammarEvents.findIndex(e => e.kind === 'sample' && e.handle === flips[0].handle);
    const flip = run.grammarEvents.findIndex(e => e.kind === 'order');
    expect(attach).toBeLessThan(firstSample);
    expect(firstSample).toBeLessThan(flip);
    expect(I44_sampleFirstFollowsIdentification(run).ok).toBe(true);
  });

  it('never flips for a tool that declares nothing, terminal or not', async () => {
    const run = await runPool({
      nCtx: 4096, cellsUsed: 0, tools: tools(), terminalToolName: 'search', policy: idle, instrument: withGrammar,
      scripts: [{ tokens: [1, 2, STOP], partialToolCall: { name: 'search', arguments: '{}' }, content: 'done' }],
    });
    expect(orders(run.grammarEvents)).toHaveLength(0);
    expect(run.grammarEvents.some(e => e.kind === 'attach')).toBe(true);
    expect(I44_sampleFirstFollowsIdentification(run).ok).toBe(true);
  });

  it("gives an extracting agent the terminal tool's order with its grammar", async () => {
    const recover: AgentPolicy = {
      onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
      hooks: [{ beforeAdmit: () => ({ type: 'drop' }) }],
      onRecovery: () => ({ type: 'extract', prompt: { systemPrompt: 's', content: 'u' } }),
      shouldExit: () => false,
      recoveryShape: 'parallel',
    };
    const run = await runPool({
      nCtx: 8192, cellsUsed: 0, tools: tools(), terminalToolName: 'report', policy: recover, instrument: withGrammar,
      scripts: [{ tokens: [1, STOP, 1, STOP], content: 'prose findings', toolCall: { name: 'report', arguments: '{"result":"recovered"}' } }],
    });
    const recovered = run.channelEvents.filter(e => e.type === 'agent:recovered');
    expect(recovered).toHaveLength(1);
    // The recovery attach is eager (not lazy) and is followed by the order, before the recovery's first sample.
    const events = run.grammarEvents;
    const eager = events.findIndex(e => e.kind === 'attach' && !e.lazy);
    expect(eager).toBeGreaterThan(-1);
    expect(events[eager + 1]).toMatchObject({ kind: 'order', sampleFirst: true, handle: (events[eager] as { handle: number }).handle });
    expect(I44_sampleFirstFollowsIdentification(run).ok).toBe(true);
  });
});
