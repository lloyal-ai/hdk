/**
 * Scenario: a cohort reaped at the context reserve writes whole reports from
 * the room above the floor (LLO-42, on the real loop).
 *
 * Shape: three agents each fetch one page the cache no longer has headroom
 * for; nothing else can progress, so the stall-break drops all three in the
 * same tick with `pressure_settle_reject`. Each recovery is given a share of
 * the room above the floor, every script has a report shorter than that
 * share, and every report ends at its own stop token.
 *
 * What this locks:
 *   - the three drops land in one tick, no trailing stop on this path;
 *   - every `pool:recoveryProduce.tokenCount` is the script's whole report,
 *     short of the share: the model ended it, not the pool;
 *   - the reports decode INTO the hard reserve, which is the report's to
 *     spend, and never below the floor the next batch needs.
 */
import { describe, it, expect } from 'vitest';
import { Tool } from '../../../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { BATCH_BUFFER, RECOVERY_PROMPT_OVERHEAD } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

class PageTool extends Tool<{ url: string }> {
  readonly name = 'fetch_page';
  readonly description = 'returns one page';
  readonly parameters: JsonSchema = { type: 'object', properties: { url: { type: 'string' } } };
  *execute(): Operation<unknown> { return { text: 'p'.repeat(8000) }; }   // about 2000 cells on the mock tokenizer
}

const SOFT = 8192;
const HARD = 6144;
const N_CTX = 32768;
const CELLS_USED = 24000;             // remaining 8768: 576 cells of headroom, three pages do not fit
const REPORT_TOKENS = 2000;           // a whole report, shorter than the share of the room

describe('scenario: cohort recovery spends the reserve, reports complete (LLO-42)', () => {
  it('three agents dropped together, each report ended by its own stop token inside the reserve', async () => {
    const tools = new Map<string, Tool>([['fetch_page', new PageTool()]]);
    const policy: AgentPolicy = {
      pressureThresholds: { softLimit: SOFT, hardLimit: HARD },
      recoveryShape: 'parallel',           // Fieldnote's medium row: cohort recovery
      onProduced: (_a, parsed) => {
        if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
        return { type: 'idle', reason: 'free_text_stop' };
      },
      // Fieldnote's nudge, sized so the replacement does not fit the headroom either.
      hooks: [{ beforeAdmit: () => ({ type: 'nudge', message: 'n'.repeat(4000) }) }],
      shouldExit: () => false,
      onRecovery: () => ({ type: 'extract', prompt: { systemPrompt: 'recover', content: 'Report now with what you have.' } }),
    };
    const script = () => ({
      tokens: [1, STOP, ...Array<number>(REPORT_TOKENS).fill(7), STOP],
      toolCall: { name: 'fetch_page', arguments: '{"url":"https://example.org/page"}' },
    });

    const run = await runPool({
      nCtx: N_CTX,
      cellsUsed: CELLS_USED,
      scripts: [script(), script(), script()],
      policy,
      tools,
      terminalToolName: 'report',
      maxTurns: 10,
      taskCount: 3,
      trace: true,
      // The mock spells a report as `t7t7…`; the recovery turn's parse must read it as the
      // terminal call, as the real model's XML would be, so the recovery RETURNS a result.
      instrument: (ctx) => {
        const inner = ctx.parseChatOutput.bind(ctx);
        ctx.parseChatOutput = (raw, format, opts) => raw.includes('t7')
          ? { content: '', reasoningContent: '', toolCalls: [{ name: 'report', arguments: JSON.stringify({ result: raw }), id: 'r' }] }
          : inner(raw, format, opts);
      },
    });

    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop') as Array<{ agentId: number; reason: string; ts: number }>;
    expect(drops.map(d => d.reason)).toEqual(['pressure_settle_reject', 'pressure_settle_reject', 'pressure_settle_reject']);
    const ticks = run.traceEvents.filter(e => e.type === 'pool:tick') as Array<{ ts: number; pressure: { remaining: number } }>;
    expect(ticks.filter(t => t.ts > drops[0].ts && t.ts < drops[drops.length - 1].ts)).toEqual([]);

    // The share each report was granted, from the pressure the drop tick read: room above the floor, shared.
    const atDrop = [...ticks].reverse().find(t => t.ts <= drops[0].ts)!;
    const share = Math.floor((atDrop.pressure.remaining - BATCH_BUFFER) / 3) - RECOVERY_PROMPT_OVERHEAD;
    expect(share).toBeGreaterThan(REPORT_TOKENS);

    const produced = run.traceEvents.filter(e => e.type === 'pool:recoveryProduce') as Array<{ agentId: number; tokenCount: number }>;
    expect(produced).toHaveLength(3);
    for (const p of produced) expect(p.tokenCount).toBe(REPORT_TOKENS);
    const returned = run.traceEvents.filter(e => e.type === 'pool:recoveryReturn') as Array<{ resultLength: number }>;
    expect(returned).toHaveLength(3);
    for (const r of returned) expect(r.resultLength).toBe(REPORT_TOKENS * 2);   // the whole `t7…` report, two chars a token
    expect(run.traceEvents.filter(e => e.type === 'pool:recoveryFailed')).toEqual([]);

    // The reports spent the hard reserve and stopped above the floor.
    const after = ticks.filter(t => t.ts > drops[0].ts);
    expect(Math.min(...after.map(t => t.pressure.remaining))).toBeLessThan(HARD);
    for (const t of after) expect(t.pressure.remaining).toBeGreaterThanOrEqual(BATCH_BUFFER);
  });
});
