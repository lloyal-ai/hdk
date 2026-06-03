/**
 * No-model smoke for the App-registry wiring in compare/main.ts.
 *
 * The compare DAG itself needs a model + reranker to run end-to-end;
 * that's out of scope for a smoke. What we *can* deterministically check
 * is the wiring change introduced in Phase E:
 *   - createInMemoryConfigStore + createAppRegistry resolve cleanly.
 *   - createWebApp's factory enables successfully (the keyless fallback
 *     path activates when no tavilyKey is set).
 *   - The enabled web app exposes a Source with the manifest-declared
 *     tools (`web_search`, `fetch_page`).
 *   - registry.byName returns the same App instance.
 *
 * Corpus is intentionally skipped — its factory requires a real reranker
 * from `RerankerCtx`. That path is covered by reasoning.run's boot flow,
 * which is the integration test for the full wiring.
 */
import * as assert from 'node:assert/strict';
import { main } from 'effection';
import {
  createAppRegistry,
  createInMemoryConfigStore,
} from '@lloyal-labs/rig';
import { createWebApp } from '@lloyal-labs/web-app';

main(function* () {
  const configStore = createInMemoryConfigStore();
  // No tavilyKey — the web app falls back to keyless DuckDuckGo.
  const registry = yield* createAppRegistry({ configStore });

  const webApp = yield* registry.enable(createWebApp);

  // Manifest is the catalog source-of-truth.
  assert.equal(webApp.manifest.name, 'web');
  assert.equal(webApp.manifest.protocol.name, 'web_research');
  assert.deepEqual(
    [...webApp.manifest.protocol.tools].sort(),
    ['fetch_page', 'web_search'],
  );

  // App.source carries the two tools the manifest declares.
  const toolNames = webApp.source.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, ['fetch_page', 'web_search']);

  // registry.byName resolves to the same App identity.
  const looked = registry.byName('web');
  assert.equal(looked, webApp);

  // registry.enabled() includes the web app exactly once.
  const enabled = registry.enabled();
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0]?.manifest.name, 'web');
});

console.log('ok  compare: web app registry wiring resolves keyless + exposes manifest tools');
