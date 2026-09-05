/**
 * The agent lifecycle is a table. Every legal move succeeds and lands on its
 * target; every other move throws and leaves the status untouched; `disposed`
 * is terminal. Checked over random paths rather than hand-picked pairs.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Agent, type AgentStatus } from '../src/Agent';
import { createMockBranch } from './helpers/mock-branch';
import { FMT } from './helpers/format-config';

const STATUSES: readonly AgentStatus[] = ['idle', 'active', 'awaiting_tool', 'disposed'];

/** The legal moves — the one table `Agent.transition` enforces. */
const LEGAL = new Set([
  'idle>active',          // first sample
  'idle>awaiting_tool',   // the close sweep parks an idle agent on its recovery turn
  'idle>disposed',        // branch pruned
  'active>awaiting_tool', // tool call, nudge or recovery turn pending
  'active>idle',          // stop token, report, or kill
  'awaiting_tool>active', // the pending turn landed
  'awaiting_tool>idle',   // dropped while waiting
]);

function agent(): Agent {
  return new Agent({ id: 1, parentId: 0, branch: createMockBranch({ handle: 1 }) as any, fmt: FMT });
}

describe('property: agent transitions follow the table', () => {
  it('legal moves land; illegal moves throw and change nothing', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...STATUSES), { maxLength: 24 }), (path) => {
        const a = agent();
        for (const to of path) {
          const from = a.status;
          if (LEGAL.has(`${from}>${to}`)) {
            a.transition(to);
            expect(a.status).toBe(to);
          } else {
            expect(() => a.transition(to)).toThrow('Invalid agent status transition');
            expect(a.status).toBe(from);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('disposed is terminal, however it was reached', () => {
    fc.assert(
      fc.property(fc.constantFrom(...STATUSES.filter(s => s !== 'disposed')), fc.constantFrom(...STATUSES), (via, to) => {
        const a = agent();
        if (via !== 'idle') a.transition(via);
        a.dispose();
        expect(a.status).toBe('disposed');
        expect(() => a.transition(to)).toThrow('Invalid agent status transition');
      }),
    );
  });

  it('startedAt stamps the first activation only', () => {
    const a = agent();
    expect(a.startedAt).toBeNull();
    a.transition('active');
    const t0 = a.startedAt;
    expect(t0).not.toBeNull();
    a.transition('awaiting_tool');
    a.transition('active');
    expect(a.startedAt).toBe(t0);
  });
});
