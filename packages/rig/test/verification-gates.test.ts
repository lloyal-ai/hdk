/**
 * §10.4 deterministic verification gates — predicate codification.
 *
 * Each §10.4 structural predicate in the App-protocol RFC has a named
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
 * - `P-no-prose-in-spine`     — `spine-render.test.ts` ("output shape is fixed across app.skill / app.examples content")
 * - `P-per-spawn-isolation`   — `spine-render.test.ts` ("does NOT include another app templates")
 * - `P-metadata-grammar`      — `define-app.test.ts` (identifier-regex + useWhen-forbidden-patterns + tools-uniqueness suites)
 * - `P-appProtocolVersion-compat` — **codified below** (gap closed by this file)
 * - `P-no-ungranted-protected-dispatch` — `@lloyal-labs/lloyal-agents/test/authGuard.test.ts` (lives there because it exercises `DefaultAgentPolicy`)
 *
 * §10.3 (model-based routing equivalence) is intentionally absent —
 * that gate is fleet-validation work tracked separately from §10
 * deterministic gates.
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { defineApp } from '../src/define-app';
import { SUPPORTED_APP_PROTOCOL_VERSIONS } from '../src/protocol';
import type { App, AppManifest, Source, Tool } from '@lloyal-labs/lloyal-agents';

function baseSpec() {
  const manifest: AppManifest = {
    name: 'gate',
    version: '1.0.0',
    appProtocolVersion: '3.0',
    protocol: {
      name: 'gate_research',
      useWhen: 'verify gate behavior',
      tools: ['gate_search'],
    },
  };
  const tool: Tool = {
    name: 'gate_search',
    description: 'search',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: function* () {
      return { content: '' };
    },
  } as unknown as Tool;
  return {
    manifest,
    source: { name: 'gate' } as Source,
    tools: { gate_search: tool },
    skill: 'body',
  };
}

// ── P-appProtocolVersion-compat ─────────────────────────────────

describe('P-appProtocolVersion-compat (§10.4)', () => {
  it('accepts every version in SUPPORTED_APP_PROTOCOL_VERSIONS', () => {
    for (const version of SUPPORTED_APP_PROTOCOL_VERSIONS) {
      const spec = baseSpec();
      spec.manifest = { ...spec.manifest, appProtocolVersion: version };
      expect(() => defineApp(spec)).not.toThrow();
    }
  });

  it('accepts an undefined appProtocolVersion (apps without one default to current)', () => {
    const spec = baseSpec();
    spec.manifest = { ...spec.manifest, appProtocolVersion: undefined };
    expect(() => defineApp(spec)).not.toThrow();
  });

  it('rejects a version outside the supported set', () => {
    const spec = baseSpec();
    spec.manifest = { ...spec.manifest, appProtocolVersion: '4.0' };
    expect(() => defineApp(spec)).toThrow(/appProtocolVersion.*supported set/);
  });

  it('rejects an empty-string version', () => {
    const spec = baseSpec();
    spec.manifest = { ...spec.manifest, appProtocolVersion: '' };
    expect(() => defineApp(spec)).toThrow(/appProtocolVersion/);
  });

  it('rejects a typo-shaped version (e.g. "3.0.1")', () => {
    const spec = baseSpec();
    spec.manifest = { ...spec.manifest, appProtocolVersion: '3.0.1' };
    expect(() => defineApp(spec)).toThrow(/appProtocolVersion/);
  });
});

// ── Returned App.manifest preserves the version round-trip ──────

describe('appProtocolVersion round-trip', () => {
  it('preserves the version on the returned App.manifest', () => {
    const spec = baseSpec();
    spec.manifest = { ...spec.manifest, appProtocolVersion: '3.0' };
    const app: App = defineApp(spec);
    expect(app.manifest.appProtocolVersion).toBe('3.0');
  });

  it('preserves undefined on the returned App.manifest (no implicit defaulting)', () => {
    const spec = baseSpec();
    spec.manifest = { ...spec.manifest, appProtocolVersion: undefined };
    const app: App = defineApp(spec);
    expect(app.manifest.appProtocolVersion).toBeUndefined();
  });
});
