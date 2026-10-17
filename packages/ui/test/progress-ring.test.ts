// @vitest-environment jsdom
/**
 * Attaching a video, said the way a messaging app says an upload: a ring that
 * fills as each phase advances, spinning where a phase has no count, and the
 * phase in plain words.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProgressRing } from '../src/progress-ring';
import { describeProgress } from '../src/video';

describe('describeProgress', () => {
  it('gives each phase its fraction, or none where it has no count, and its words', () => {
    expect(describeProgress({ phase: 'uploading', done: 9_800_000, total: 23_677_876 })).toEqual({ fraction: 9_800_000 / 23_677_876, text: 'Uploading 9.8 of 23.7 MB' });
    expect(describeProgress({ phase: 'sampling' })).toEqual({ fraction: null, text: 'Reading frames' });
    expect(describeProgress({ phase: 'ingesting', done: 12, total: 64 })).toEqual({ fraction: 12 / 64, text: 'Frames 12 of 64' });
    expect(describeProgress({ phase: 'transcribing', done: 31, total: 120 })).toEqual({ fraction: 31 / 120, text: 'Transcribing 31 of 120' });
    expect(describeProgress({ phase: 'composing' })).toEqual({ fraction: null, text: 'Putting it together' });
    expect(describeProgress({ phase: 'uploading', done: 0, total: 0 }).fraction).toBe(0);
  });
});

describe('ProgressRing', () => {
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  const render = (props: Parameters<typeof ProgressRing>[0]): HTMLElement => {
    const container = document.createElement('div');
    act(() => createRoot(container).render(createElement(ProgressRing, props)));
    return container.querySelector('[role="progressbar"]')!;
  };

  it('fills to its fraction, shows the percentage in its middle, and says it to a screen reader', () => {
    const ring = render({ fraction: 0.42, label: 'Uploading 9.8 of 23.7 MB' });
    expect(ring.getAttribute('aria-valuenow')).toBe('42');
    expect(ring.getAttribute('aria-label')).toBe('Uploading 9.8 of 23.7 MB');
    expect(ring.textContent).toContain('42%');
  });

  it('spins without a value when the phase has no count', () => {
    const ring = render({ fraction: null, label: 'Reading frames' });
    expect(ring.hasAttribute('aria-valuenow')).toBe(false);
    expect(ring.textContent).not.toContain('%');
    expect(ring.querySelector('.lloyal-ring-spin')).not.toBeNull();
  });

  it('holds still for a reader who asked for reduced motion: the words carry the progress', () => {
    const ring = render({ fraction: null, label: 'Reading frames' });
    expect(ring.querySelector('style')!.textContent).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.lloyal-ring-spin\s*\{\s*animation:\s*none/);
  });
});
