import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Wizard, orderTargets } from '../src/commands/new-wizard.js';
import { MODEL_FOOTPRINT_HINT } from '../src/scaffold/model-catalog.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// COVERAGE BOUNDARY: the full keystroke-driven flow (name → targets → model →
// template) is NOT asserted here. Character input to @inkjs/ui's `TextInput`
// does not deliver under ink-testing-library's simulated stdin (the field keeps
// showing its placeholder), so an end-to-end keystroke test can't be driven
// headlessly — it needs a human smoke in a real terminal before release. What
// IS covered: the wizard mounts + renders the name prompt (below); the
// "cli always kept" invariant it enforces (orderTargets, below); and the pure
// scaffold logic it hands off to (pruneTargets / applyModelChoice — see
// new-scaffold.test.ts). The wizard drives the SAME @inkjs/ui TextInput/
// Select components the shipped `targets/cli/view.tsx` templates use.

describe('new wizard — render', () => {
  it('mounts and renders the name prompt first (no crash)', () => {
    const { lastFrame } = render(createElement(Wizard, { onDone: () => {} }));
    expect(lastFrame()).toContain('Scaffold a new harness');
    expect(lastFrame()).toContain('Harness name');
  });
});

describe('MODEL_FOOTPRINT_HINT — the hardware floor shown at the model step', () => {
  // The keystroke flow can't be driven headlessly (see the coverage boundary
  // above), so the model step's frame isn't asserted. What IS worth pinning is
  // the CONTENT: the download figure is derived from rig's catalog, and the
  // vendored copy in model-catalog.ts already carries a "keep in sync" warning.
  // Without this, rig can swap the recommended model and the wizard keeps
  // quoting a stale size at the exact moment the user commits to it.
  const rigModels = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../rig/src/models.ts'),
    'utf8',
  );

  it('quotes a download size that matches rig’s sizeBytes for the recommended model', () => {
    const entry = rigModels.slice(rigModels.indexOf("id: 'qwen3.5-4b'"));
    const bytes = Number(
      /sizeBytes:\s*([\d_]+)/.exec(entry)?.[1]?.replaceAll('_', '') ?? NaN,
    );
    expect(Number.isFinite(bytes)).toBe(true);
    const quoted = Number(/([\d.]+)\s*GB download/.exec(MODEL_FOOTPRINT_HINT)?.[1] ?? NaN);
    // Same figure to one decimal, in GB as a human reads it (2_600_000_000 → 2.6).
    expect(quoted).toBeCloseTo(bytes / 1e9, 1);
  });

  it('states that concurrent agents do not multiply the requirement', () => {
    // The counter-intuitive half, and the reason the hint exists at all —
    // readers assume four agents means four times the model.
    expect(MODEL_FOOTPRINT_HINT).toMatch(/share one context/i);
    expect(MODEL_FOOTPRINT_HINT).toMatch(/16 GB/);
  });
});

describe('orderTargets — cli is never droppable', () => {
  it('re-adds cli even when the user unchecked it', () => {
    expect(orderTargets(['web'])).toEqual(['cli', 'web']);
    expect(orderTargets([])).toEqual(['cli']);
    expect(orderTargets(['desktop', 'web'])).toEqual(['cli', 'desktop', 'web']);
  });

  it('returns targets in canonical order regardless of selection order', () => {
    expect(orderTargets(['web', 'desktop', 'cli'])).toEqual(['cli', 'desktop', 'web']);
  });
});
