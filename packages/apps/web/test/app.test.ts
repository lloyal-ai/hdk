import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { AppConfigStoreCtx } from '@lloyal-labs/lloyal-agents';
import { createInMemoryConfigStore } from '@lloyal-labs/rig';
import { createWebApp } from '../src/index';

describe('createWebApp', () => {
  it('builds the web_research app with full tool-map coverage', async () => {
    const app = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('web', { tavilyKey: 'test-key' }); // Tavily path — no background pacer
      yield* AppConfigStoreCtx.set(store);
      return yield* createWebApp();
    });

    expect(app.manifest.name).toBe('web');
    expect(app.manifest.protocol.name).toBe('web_research');
    expect(app.manifest.protocol.tools).toEqual(['web_search', 'fetch_page']);
    expect(app.source.name).toBe('web');
    // App.tools (array) must cover exactly the protocol's tools.
    expect(app.tools.map((t) => t.name).sort()).toEqual(['fetch_page', 'web_search']);
    // skill.eta must NOT carry the framework boundary marker (defineApp would reject it).
    const agentSrc = typeof app.skill === 'string' ? app.skill : '';
    expect(agentSrc).not.toContain('Apply the **');
  });
});
