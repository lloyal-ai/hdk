/**
 * §10.5 property tests — randomized invariant checking.
 *
 * Where `verification-gates.test.ts` codifies §10.4 predicates against
 * fixed inputs, this file feeds randomized inputs into the same
 * predicates to catch hand-picked-case bias. fast-check is dev-only
 * (hoisted from root `devDependencies`) and runs each property 100
 * times by default.
 *
 * Properties:
 *   1. **Catalog ordering** — for any N (1..12) apps with valid
 *      identifiers, `renderSpine` emits each catalog block in
 *      registration order. Random app permutations.
 *   2. **Boundary marker** — for any valid app + any AgentRenderCtx,
 *      `renderAgentPreamble` starts with the boundary marker. The
 *      marker contains the manifest's `protocol.name`, not the app's
 *      `name`, even for adversarial renderings.
 *   3. **Catalog presence** — every registered app's `protocol.name`
 *      appears in the rendered spine exactly once. No app is silently
 *      dropped; none is duplicated.
 *
 * Properties are intentionally pure-rendering — random enable/disable
 * interleavings (which would exercise the registry's reverse-teardown
 * order) require Effection wiring and live in a separate registry
 * property test (deferred).
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { App, AppManifest } from '@lloyal-labs/lloyal-agents';
import { renderSpine, renderAgentPreamble } from '../src/spine-render';
import { BOUNDARY_MARKER } from '../src/protocol';

/** Arbitrary for a valid app identifier per the M3 regex
 *  `[a-z][a-z0-9_-]{1,63}`. */
const idArb = fc
  .stringMatching(/^[a-z][a-z0-9_-]{1,63}$/)
  .filter((s) => s.length >= 2 && s.length <= 32);

/** Arbitrary for a benign useWhen string (no forbidden patterns:
 *  no chat-role markers, no newlines, no code fences). */
const useWhenArb = fc
  .stringMatching(/^[a-zA-Z0-9 ,.;:!?'-]{8,200}$/)
  .map((s) => s.replace(/SYSTEM:|USER:|ASSISTANT:|```/g, 'x'));

/** Arbitrary for a single App fixture. Uses a fresh identifier for
 *  each of `name`, `protocol.name`, and each tool. */
const appArb = fc.record({
  name: idArb,
  protocolName: idArb,
  useWhen: useWhenArb,
  tools: fc.array(idArb, { minLength: 1, maxLength: 5 }),
}).map(({ name, protocolName, useWhen, tools }): App => {
  const manifest: AppManifest = {
    name,
    version: '1.0.0',
    appProtocolVersion: '3.0',
    protocol: { name: protocolName, useWhen, tools: [...new Set(tools)] },
  };
  return {
    name,
    version: '1.0.0',
    manifest,
    source: { name } as App['source'],
    tools: [],
    skill: 'body <%= it.agentCount %>',
  };
});

const ctxArb = fc.record({
  agentCount: fc.integer({ min: 1, max: 8 }),
  siblingTasks: fc.array(fc.string(), { maxLength: 4 }),
  maxTurns: fc.integer({ min: 1, max: 50 }),
  date: fc.constant('2026-05-19'),
  taskIndex: fc.integer({ min: 0, max: 10 }),
});

describe('§10.5 property: P-catalog-order across random app sets', () => {
  it('renderSpine emits catalog blocks in registration order for any 1..12 apps', () => {
    fc.assert(
      fc.property(
        fc.array(appArb, { minLength: 1, maxLength: 12 }).filter((apps) => {
          // Distinct protocol.name across apps — required by M3
          // (registry uniqueness) and to make the order assertion
          // unambiguous.
          const names = apps.map((a) => a.manifest.protocol.name);
          return new Set(names).size === names.length;
        }),
        (apps) => {
          const out = renderSpine({ apps });
          let lastIdx = -1;
          for (const app of apps) {
            // Match `## <name>\n` (not `## <name>`) so an app with name
            // `a` doesn't false-match inside an app `ab` block.
            const idx = out.indexOf(`## ${app.manifest.protocol.name}\n`);
            expect(idx).toBeGreaterThan(lastIdx);
            lastIdx = idx;
          }
        },
      ),
    );
  });
});

describe('§10.5 property: P-boundary-marker across random AgentRenderCtx', () => {
  it('renderAgentPreamble starts with the protocol-name boundary marker for any context', () => {
    fc.assert(
      fc.property(appArb, ctxArb, (app, ctx) => {
        const out = renderAgentPreamble(app, ctx);
        expect(out.startsWith(BOUNDARY_MARKER(app.manifest.protocol.name))).toBe(true);
      }),
    );
  });
});

describe('§10.5 property: catalog presence is exact (no drops, no duplicates)', () => {
  it('every registered app appears exactly once in the rendered spine', () => {
    fc.assert(
      fc.property(
        fc.array(appArb, { minLength: 1, maxLength: 12 }).filter((apps) => {
          const names = apps.map((a) => a.manifest.protocol.name);
          return new Set(names).size === names.length;
        }),
        (apps) => {
          const out = renderSpine({ apps });
          for (const app of apps) {
            const marker = `## ${app.manifest.protocol.name}\n`;
            const matches = out.split(marker).length - 1;
            expect(matches).toBe(1);
          }
        },
      ),
    );
  });
});
