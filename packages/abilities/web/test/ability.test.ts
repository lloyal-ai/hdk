import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { AbilityConfigStoreCtx } from '@lloyal-labs/lloyal-agents';
import { createInMemoryConfigStore } from '@lloyal-labs/rig';
import { createWebAbility } from '../src/index';

describe('createWebAbility', () => {
  it('builds the web_research ability with full tool-map coverage', async () => {
    const ability = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('web', { tavilyKey: 'test-key' }); // Tavily path — no background pacer
      yield* AbilityConfigStoreCtx.set(store);
      return yield* createWebAbility();
    });

    expect(ability.manifest.name).toBe('web');
    expect(ability.manifest.protocol.name).toBe('web_research');
    expect(ability.manifest.protocol.tools).toEqual(['web_search', 'fetch_page']);
    expect(ability.source.name).toBe('web');
    // Ability.tools (array) must cover exactly the protocol's tools.
    expect(ability.tools.map((t) => t.name).sort()).toEqual(['fetch_page', 'web_search']);
    // skill.eta must NOT carry the framework boundary marker (defineAbility would reject it).
    const agentSrc = typeof ability.skill === 'string' ? ability.skill : '';
    expect(agentSrc).not.toContain('Apply the **');
  });
});
