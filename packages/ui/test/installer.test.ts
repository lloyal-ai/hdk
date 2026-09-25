/**
 * The installer: drawn from the whole step list, the active step's bytes on the bar, a file offered only
 * where a placement can choose one and the step takes one, the failure's remedies in the footer, and the
 * harness's theme read from custom properties with the platform's values as defaults.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Installer, rateOf } from '../src/installer';
import type { InstallerStep } from '../src/installer';

const steps: InstallerStep[] = [
  { id: 'machine', label: 'This machine', status: 'done', note: '16 GB · 10 GB needed' },
  { id: 'llm', label: 'Getting the model', status: 'running', got: 1024 ** 3, total: 2 * 1024 ** 3, file: true },
  { id: 'reranker', label: 'Getting the reranker', status: 'pending', file: true },
];

describe('Installer', () => {
  it('draws every step, names the active one, and measures its bytes on the bar', () => {
    const html = renderToString(createElement(Installer, { steps, footnote: 'First run only' }));
    expect(html).toContain('STEP 2 OF 3');
    expect(html).toContain('Getting the model');
    expect(html).toContain('Getting the reranker');
    expect(html).toContain('1.00 GB');
    expect(html).toContain('2.00 GB');
    expect(html).toContain('width:50%');
    expect(html).toContain('First run only');
    expect(html).toContain('16 GB · 10 GB needed');
  });

  it('offers a file only for the step that takes one and is running or failed, and only where one can be chosen', () => {
    const without = renderToString(createElement(Installer, { steps }));
    expect(without).not.toContain('Use a file I already have');
    const withChooser = renderToString(createElement(Installer, { steps, onUseFile: () => {} }));
    expect(withChooser.match(/Use a file I already have/g)).toHaveLength(1);
    const noFile = steps.map((s) => ({ ...s, file: false }));
    expect(renderToString(createElement(Installer, { steps: noFile, onUseFile: () => {} }))).not.toContain('Use a file I already have');
  });

  it('a failure shows its reason and the remedies; nothing is drawn for an empty list', () => {
    const failed = [steps[0], { ...steps[1], status: 'failed' as const, got: undefined, total: undefined, note: 'Failed to fetch from any source' }, steps[2]];
    const html = renderToString(createElement(Installer, { steps: failed, onRetry: () => {}, onStop: () => {} }));
    expect(html).toContain('STOPPED AT STEP 2');
    expect(html).toContain('Failed to fetch from any source');
    expect(html).toContain('Try again');
    expect(html).toContain('>Stop<');
    expect(renderToString(createElement(Installer, { steps: [] }))).toBe('');
  });

  it('the rate is measured from one step\'s samples: none before a second has passed, none for a step whose bytes have not moved, and a fresh window says nothing', () => {
    expect(rateOf([], 1000)).toBeNull();
    expect(rateOf([{ at: 0, got: 0 }], 500)).toBeNull();                                  // under a second
    expect(rateOf([{ at: 0, got: 100 }, { at: 1000, got: 100 }], 1000)).toBeNull();      // nothing moved
    expect(rateOf([{ at: 0, got: 0 }, { at: 2000, got: 4096 }], 2000)).toBe(2048);
    // A new step's first sample is a fresh window — what `useRate` empties on a step change — so a step that
    // finished at 2 GB never lends its speed to the one that just began at 0.
    expect(rateOf([{ at: 5000, got: 0 }], 5000)).toBeNull();
  });

  it('takes the harness theme from custom properties, with the platform values as defaults', () => {
    const html = renderToString(createElement(Installer, { steps }));
    expect(html).toContain('var(--harness-accent, #3A56D4)');
    expect(html).toContain('var(--harness-bg, #FFFFFF)');
    expect(html).toContain('var(--harness-font, system-ui, sans-serif)');
  });
});
