import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { RecordingWaveform } from '../src/recording-waveform';

describe('the recording waveform', () => {
  it('draws real levels in the harness register with the running clock while recording', () => {
    const html = renderToString(createElement(RecordingWaveform, { levels: [0, 0.25, 1], elapsed: 64, recording: true }));
    expect(html).toContain('01:04');
    expect(html).toContain('height="25"');
    expect(html).toContain('fill="var(--harness-fg, currentColor)"');
    expect(html).toContain('var(--harness-mono');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('Whisper');
  });
  it('holds the last shape dimmed and without a clock once recording has stopped', () => {
    const html = renderToString(createElement(RecordingWaveform, { levels: [0.5], elapsed: 9, recording: false }));
    expect(html).toContain('opacity:0.45');
    expect(html).not.toContain('00:09');
    expect(html).toContain('height="14"');
  });
  it('offers a quiet dotted baseline for reduced motion with no invented activity', () => {
    const html = renderToString(createElement(RecordingWaveform, { levels: [], elapsed: 0, recording: true }));
    expect(html).toContain('lloyal-wave-still');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).not.toContain('height="25"');
  });
});
