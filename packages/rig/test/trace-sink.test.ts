/**
 * The writer-boundary mirror — `useTraceWriter`'s third parameter is the dev
 * pane's live feed. Contracts:
 *
 *   1. With `dev` and a `send`, EVERY write is carried as an `agent:trace`
 *      envelope whose attribution comes off the event's own fields
 *      (`agentId`, else `branchHandle`, else -1; `callId` when present) —
 *      and the file write still lands.
 *   2. Without `dev` the writer is Null and nothing mirrors — production
 *      streams never carry envelopes.
 *   3. A failed file open does not silence the mirror: pane observability
 *      is not a disk dependency.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTraceWriter } from '../src/trace-sink';
import type { AgentTraceEvent, TraceEvent } from '@lloyal-labs/lloyal-agents';

const ev = (over: Record<string, unknown>): TraceEvent => ({
  traceId: 1, parentTraceId: null, ts: 0, type: 'scope:open', name: 'x',
  ...over,
} as unknown as TraceEvent);

describe('useTraceWriter mirror', () => {
  it('mirrors every write, attributed off the event data, and still writes the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-sink-'));
    const sent: AgentTraceEvent[] = [];
    await run(function* () {
      const tw = yield* useTraceWriter(dir, true, (e) => sent.push(e));
      tw.write(ev({ agentId: 7, callId: 'call_1' }));
      tw.write(ev({ traceId: 2, type: 'branch:prefill', branchHandle: 3, cells: 10, role: 'warmDelta', content: 'hi' }));
      tw.write(ev({ traceId: 3 }));
      tw.flush();
    });
    expect(sent.map((s) => s.agentId)).toEqual([7, 3, -1]);
    expect(sent[0].callId).toBe('call_1');
    expect(sent[1].callId).toBeUndefined();
    expect(sent[1].event.type).toBe('branch:prefill');
    const file = readdirSync(dir).find((f) => f.startsWith('trace-'));
    expect(file).toBeDefined();
    expect(readFileSync(join(dir, file!), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('dev off: Null writer, no mirror', async () => {
    const sent: AgentTraceEvent[] = [];
    await run(function* () {
      const tw = yield* useTraceWriter(mkdtempSync(join(tmpdir(), 'trace-sink-')), false, (e) => sent.push(e));
      tw.write(ev({ agentId: 1 }));
      return undefined;
    });
    expect(sent).toHaveLength(0);
  });

  it('a failed file open does not silence the mirror', async () => {
    const sent: AgentTraceEvent[] = [];
    // A path that cannot be created: a directory under an existing FILE.
    const dir = mkdtempSync(join(tmpdir(), 'trace-sink-'));
    const blocked = join(dir, 'occupied');
    writeFileSync(blocked, '');
    await run(function* () {
      const tw = yield* useTraceWriter(join(blocked, 'sub'), true, (e) => sent.push(e));
      tw.write(ev({ agentId: 1 }));
      return undefined;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe(1);
  });
});
