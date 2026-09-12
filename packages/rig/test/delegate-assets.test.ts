/**
 * A delegated child pool starts with the assets the delegating call can see —
 * the run's staged roots plus everything admitted so far — not with the
 * static pool options alone.
 *
 * @category Testing
 */
import { describe, it, expect, vi } from 'vitest';
import { run } from 'effection';

const seen = vi.hoisted(() => ({ poolOpts: [] as Record<string, unknown>[] }));
vi.mock('@lloyal-labs/lloyal-agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lloyal-labs/lloyal-agents')>();
  return {
    ...actual,
    agentPool: vi.fn(function* (opts: Record<string, unknown>) {
      seen.poolOpts.push(opts);
      return { agents: [], totalTokens: 0, totalToolCalls: 0 };
    }),
  };
});

import { Trace, NullTraceWriter } from '@lloyal-labs/lloyal-agents';
import type { ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Attachment } from '@lloyal-labs/media';
import { DelegateTool } from '../src/tools/delegate';

const root = (hex: string): Attachment =>
  ({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${hex.repeat(64)}`, size: 700 }) as unknown as Attachment;

describe('delegate — the child pool inherits the run\'s assets', () => {
  it('forwards the delegating call\'s attachments into agentPool, admitted roots included', async () => {
    const staged = root('a');
    const admittedMidRun = root('b');
    const tool = new DelegateTool({ poolOpts: {}, systemPrompt: 'sys', extractTasks: (a) => a.tasks as string[] });
    await run(function* () {
      yield* Trace.set(new NullTraceWriter());
      return yield* tool.execute({ tasks: ['look into it'] }, { agentId: 7, attachments: [staged, admittedMidRun] } as unknown as ToolContext);
    });
    expect(seen.poolOpts).toHaveLength(1);
    expect(seen.poolOpts[0].attachments).toEqual([staged, admittedMidRun]);
  });
});
