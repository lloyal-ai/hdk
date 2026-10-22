/**
 * The ffmpeg decoder reads the streams its probe describes. A file with a second
 * picture and a second sound, flagged as the defaults, is the case where ffmpeg's
 * own choice of stream differs from the probe's: the frames and the samples must
 * still come from the first of each, at the rate and channels the probe read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ffmpegDecoder } from './ffmpeg-decoder';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();

describe.runIf(hasFfmpeg)('ffmpegDecoder on a file with two pictures and two sounds', () => {
  let dir: string;
  let file: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ffmpeg-decoder-'));
    file = join(dir, 'two-tracks.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=10:d=4',
      '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=25:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4',
      '-map', '0', '-map', '1', '-map', '2', '-map', '3',
      '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-ac:a:1', '6',
      '-disposition:v:0', '0', '-disposition:v:1', 'default', '-disposition:a:0', '0', '-disposition:a:1', 'default',
      file,
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('decodes frames from the first picture, at its own rate', async () => {
    const decoder = ffmpegDecoder(file);
    try {
      expect(await decoder.picture()).toMatchObject({ width: 320, height: 240 });
      const shown = [];
      for await (const frame of decoder.frames([1.0, 1.3], { width: 320, height: 240 })) shown.push(frame!);
      expect(shown.map((f) => f.shownS)).toEqual([1.0, 1.3]);
      const { channels } = await sharp(Buffer.from(shown[0].bytes)).stats();
      expect(channels[0].mean).toBeGreaterThan(200);
      expect(channels[2].mean).toBeLessThan(60);
    } finally {
      decoder.dispose();
    }
  });

  it('decodes the sound of the first track, at its own rate and channels', async () => {
    const decoder = ffmpegDecoder(file);
    try {
      let samples = 0;
      for await (const chunk of decoder.sound()) {
        expect(chunk).toMatchObject({ sampleRate: 16000 });
        expect(chunk.channels).toHaveLength(1);
        samples += chunk.channels[0].length;
      }
      expect(samples / 16000).toBeCloseTo(4, 1);
    } finally {
      decoder.dispose();
    }
  });
});

describe.runIf(hasFfmpeg)('ffmpegDecoder on the clip\'s own clock', () => {
  let dir: string;
  let gapped: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ffmpeg-decoder-clock-'));
    // A 4 s clip whose timestamps start at 1.4 s, in two containers: Matroska reports where it ends, mp4 its length.
    for (const [name, audio] of [['late.mkv', 'pcm_s16le'], ['late.mp4', 'aac']]) {
      execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=10:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=4',
        '-c:v', 'mpeg4', '-c:a', audio, '-output_ts_offset', '1.4', join(dir, name),
      ]);
    }
    // 2 s of sound with a 1 s gap in its timestamps after the first second.
    gapped = join(dir, 'gapped.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', "sine=frequency=440:sample_rate=16000:duration=2,asetpts='PTS+if(gte(T,1),16000,0)'",
      '-c:a', 'pcm_s16le', gapped,
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(['late.mkv', 'late.mp4'])('%s ends where the clip ends on its clock, and shows the frame asked for there', async (name) => {
    const decoder = ffmpegDecoder(join(dir, name));
    try {
      expect(await decoder.duration()).toBeCloseTo(5.4, 3);
      expect(await decoder.picture()).toMatchObject({ startS: 1.4 });
      const shown = [];
      for await (const frame of decoder.frames([2.4, 2.7], { width: 320, height: 240 })) shown.push(frame!.shownS);
      expect(shown).toEqual([2.4, 2.7]);
    } finally {
      decoder.dispose();
    }
  });

  it('places sound after a gap in its timestamps where it is presented, the gap silent', async () => {
    const decoder = ffmpegDecoder(gapped);
    try {
      let samples = 0;
      for await (const run of decoder.sound()) samples += run.channels[0].length;
      expect(samples / 16000).toBeCloseTo(3, 1);
    } finally {
      decoder.dispose();
    }
  });
});
