/**
 * §10.4 deterministic verification gates — predicate codification.
 *
 * Each §10.4 structural predicate in the Ability-protocol RFC has a named
 * test below (or a cross-reference comment if it lives in another
 * package's test suite). The aim is single-source traceability:
 * grepping for `P-<name>` lands on the canonical assertion.
 *
 * §10.4 predicate ownership map:
 *
 * - `P-boundary-marker`       — `spine-render.test.ts` ("starts with the boundary marker verbatim")
 * - `P-catalog-header`        — `spine-render.test.ts` ("emits `# Protocols` block after the intro")
 * - `P-catalog-order`         — `spine-render.test.ts` ("emits catalog entries in registration order")
 * - `P-catalog-shape`         — `spine-render.test.ts` ("emits catalog block in exact RFC §1.2 shape")
 * - `P-spine-intro`           — `spine-render.test.ts` ("emits FRAMEWORK_INTRO verbatim at the start")
 * - `P-tool-selection-rule`   — `spine-render.test.ts` ("emits TOOL_SELECTION_RULE as the final block")
 * - `P-no-prose-in-spine`     — `spine-render.test.ts` ("output shape is fixed across ability.skill / ability.examples content")
 * - `P-per-spawn-isolation`   — `spine-render.test.ts` ("does NOT include another ability templates")
 * - `P-metadata-grammar`      — `define-ability.test.ts` (identifier-regex + useWhen-forbidden-patterns + tools-uniqueness suites)
 * - `P-abilityProtocolVersion-compat` — **codified below** (gap closed by this file)
 * - `P-no-ungranted-protected-dispatch` — `@lloyal-labs/lloyal-agents/test/authGuard.test.ts` (lives there because it exercises `DefaultAgentPolicy`)
 *
 * §10.3 (model-based routing equivalence) is intentionally absent —
 * that gate is fleet-validation work tracked separately from §10
 * deterministic gates.
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { defineAbility } from '../src/define-ability';
import type { AbilitySetup } from '../src/define-ability';
import { SUPPORTED_ABILITY_PROTOCOL_VERSIONS } from '../src/protocol';
import type { AbilityManifest, Source, Tool } from '@lloyal-labs/lloyal-agents';

const baseManifest: AbilityManifest = {
  name: 'gate',
  abilityProtocolVersion: '3.0',
  protocol: {
    name: 'gate_research',
    useWhen: 'verify gate behavior',
    tools: ['gate_search'],
  },
};

function parts(): AbilitySetup {
  const tool: Tool = {
    name: 'gate_search',
    description: 'search',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: function* () {
      return { content: '' };
    },
  } as unknown as Tool;
  return {
    source: { name: 'gate' } as Source,
    tools: { gate_search: tool },
    skill: 'body',
  };
}

/** Build the factory — eager manifest validation happens at this call. */
function build(manifest: AbilityManifest) {
  return defineAbility(manifest, function* () {
    return parts();
  });
}

// ── P-abilityProtocolVersion-compat ─────────────────────────────────

describe('P-abilityProtocolVersion-compat (§10.4)', () => {
  it('accepts every version in SUPPORTED_ABILITY_PROTOCOL_VERSIONS', () => {
    for (const version of SUPPORTED_ABILITY_PROTOCOL_VERSIONS) {
      expect(() => build({ ...baseManifest, abilityProtocolVersion: version })).not.toThrow();
    }
  });

  it('accepts an undefined abilityProtocolVersion (abilities without one default to current)', () => {
    expect(() => build({ ...baseManifest, abilityProtocolVersion: undefined })).not.toThrow();
  });

  it('rejects a version outside the supported set', () => {
    expect(() => build({ ...baseManifest, abilityProtocolVersion: '4.0' })).toThrow(
      /abilityProtocolVersion.*supported set/,
    );
  });

  it('rejects an empty-string version', () => {
    expect(() => build({ ...baseManifest, abilityProtocolVersion: '' })).toThrow(/abilityProtocolVersion/);
  });

  it('rejects a typo-shaped version (e.g. "3.0.1")', () => {
    expect(() => build({ ...baseManifest, abilityProtocolVersion: '3.0.1' })).toThrow(/abilityProtocolVersion/);
  });
});

// ── Factory manifest preserves the version round-trip ───────────

describe('abilityProtocolVersion round-trip', () => {
  it('preserves the version on the factory manifest', () => {
    const factory = build({ ...baseManifest, abilityProtocolVersion: '3.0' });
    expect(factory.manifest?.abilityProtocolVersion).toBe('3.0');
  });

  it('preserves undefined on the factory manifest (no implicit defaulting)', () => {
    const factory = build({ ...baseManifest, abilityProtocolVersion: undefined });
    expect(factory.manifest?.abilityProtocolVersion).toBeUndefined();
  });
});
