/**
 * The ability contract — what `defineAbility` and the harness require, checked
 * where a developer will see it rather than at someone else's enable().
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { AbilityConfigStoreCtx } from '@lloyal-labs/lloyal-agents';
// The store factory lives in rig, not agents — agents defines the interface and
// rig the concrete backend, the same split as Source and Tool.
import { createInMemoryConfigStore } from '@lloyal-labs/rig';
import { createTimelineAbility } from '../src/index';

const enable = (config: Record<string, unknown> | null) =>
  run(function* () {
    const store = createInMemoryConfigStore();
    if (config) yield* store.set('timeline', config);
    yield* AbilityConfigStoreCtx.set(store);
    return yield* createTimelineAbility();
  });

describe('createTimelineAbility', () => {
  it('exposes the protocol and the tool its manifest promises', async () => {
    const ability = await enable({ locale: 'en-GB' });
    expect(ability.manifest.protocol.name).toBe('timeline_chronology');
    // Note the asymmetry: AbilitySetup.tools is a name→Tool RECORD going in,
    // and defineAbility normalises it to an ARRAY on the runtime Ability. The
    // record's keys must equal manifest.protocol.tools as a set, which is what
    // guarantees the catalog's Tools: line matches what can be dispatched.
    expect(ability.tools.map((t) => t.name)).toEqual(['build_timeline']);
  });

  it('refuses to start without a locale', async () => {
    // 03/04/24 is 3 April under en-GB and 4 March under en-US. A default would
    // make a chronology silently wrong by a year; failing here is far cheaper.
    await expect(enable({})).rejects.toThrow(/locale/);
    await expect(enable(null)).rejects.toThrow(/locale/);
  });

  it('names the consequence in the error, not just the missing key', async () => {
    await expect(enable({})).rejects.toThrow(/differs by a year|03\/04\/24/);
  });

  it('renders a skill carrying the configured definition of an event', async () => {
    const criteria = 'Only decisions, notices and statutory deadlines.';
    const ability = await enable({ locale: 'en-GB', criteria });
    const skill =
      typeof ability.skill === 'function'
        ? ability.skill({
            agentCount: 1,
            siblingTasks: [],
            maxTurns: 8,
            date: '2026-08-17',
            taskIndex: 0,
          })
        : ability.skill;
    // The whole reason the skill is a function: `criteria` is not part of
    // AgentRenderCtx, so a string template would render it empty and lose the
    // domain's definition of an event without any error.
    expect(skill).toContain(criteria);
  });

  it('falls back to a generic definition rather than an empty one', async () => {
    const ability = await enable({ locale: 'en-GB' });
    const skill =
      typeof ability.skill === 'function'
        ? ability.skill({
            agentCount: 1,
            siblingTasks: [],
            maxTurns: 8,
            date: '2026-08-17',
            taskIndex: 0,
          })
        : ability.skill;
    expect(skill).toMatch(/WHAT COUNTS AS AN EVENT:\s*\S/);
  });

  it('never contains the boundary marker the framework prepends', async () => {
    const ability = await enable({ locale: 'en-GB' });
    const skill =
      typeof ability.skill === 'function'
        ? ability.skill({
            agentCount: 1,
            siblingTasks: [],
            maxTurns: 8,
            date: '2026-08-17',
            taskIndex: 0,
          })
        : ability.skill;
    expect(skill).not.toContain('Apply the **');
  });

  it('declares a useWhen the planner will accept', async () => {
    const ability = await enable({ locale: 'en-GB' });
    const useWhen = ability.manifest.protocol.useWhen;
    // 280 is enforced at import by defineAbility; the spec's own draft was 318
    // and would have thrown before any of this ran.
    expect(useWhen.length).toBeLessThanOrEqual(280);
    expect(useWhen).not.toMatch(/[\n\r]/);
  });
});
