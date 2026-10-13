/**
 * The drop reason rides on the bus `agent:done` (LLO-44): the harness names
 * why a span ended where its text is, in the reader's words. A return has no
 * reason (the agent finished on its own); a cancel has no done at all.
 */
import { describe, it, expect } from 'vitest';
import { project } from '../src/emit';
import type { Agent } from '../src/Agent';

const agent = { id: 7, result: 'kept' } as unknown as Agent;
const bus = (t: Parameters<typeof project>[0]) => project(t).flatMap(e => 'bus' in e && e.bus ? [e.bus] : []);

describe('agent:done carries the drop reason', () => {
  it('a drop with a reason announces it on the bus done', () => {
    const out = bus({ kind: 'drop', agent, reason: 'pressure_critical', done: true });
    expect(out).toEqual([{ type: 'agent:done', agentId: 7, reason: 'pressure_critical' }]);
  });

  it('a drop without a reason (a free-text stop) is a bare done', () => {
    expect(bus({ kind: 'drop', agent, reason: null, done: true })).toEqual([{ type: 'agent:done', agentId: 7 }]);
  });

  it('a return is a bare done after the return', () => {
    const out = bus({ kind: 'returned', agent, via: 'free_text' });
    expect(out).toEqual([
      { type: 'agent:return', agentId: 7, result: 'kept' },
      { type: 'agent:done', agentId: 7 },
    ]);
  });

  it('a cancel is a failure with no done', () => {
    expect(bus({ kind: 'cancelled', agent })).toEqual([{ type: 'agent:failed', agentId: 7, reason: 'user_cancel' }]);
  });
});
