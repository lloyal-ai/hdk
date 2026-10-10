import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { RecordingWaveform } from '../src/recording-waveform';

describe('the recording strip', () => {
  it('shows elapsed recording time, real levels, and an accessible status', () => {
    const html = renderToString(createElement(RecordingWaveform, { levels: [0, 0.25, 1], elapsed: 64, recording: true }));
    expect(html).toContain('01:04');
    expect(html).toContain('Recording');
    expect(html).toContain('height="28"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('Whisper');
  });
  it('uses a quiet dotted baseline with no invented activity', () => {
    const html = renderToString(createElement(RecordingWaveform, { levels: [], elapsed: 0, recording: false }));
    expect(html).toContain('00:00');
    expect(html).not.toContain('height="28"');
    expect(html).toContain('Click to speak');
  });
});
