import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Wizard, orderTargets } from '../src/commands/new-wizard.js';

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
    expect(lastFrame()).toContain('Harness name:');
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
