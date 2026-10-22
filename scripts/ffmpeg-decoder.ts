/**
 * A clip decoder over ffmpeg, for tools that read video outside a page.
 *
 * It implements media's `ClipDecoder` and nothing more: it opens the file and
 * hands over pictures and sound. What is sampled, how each frame is stamped,
 * how the sound is mixed, decimated, placed and cut, and what a compose is
 * sent, is media's procedure (`prepareVideo`), the same one the page runs
 * through its WebCodecs decoder. Swapping decoders changes only this file.
 *
 * It reads constant-frame-rate pictures: the frame shown at a time is found
 * from the stream's rate, and every frame ffmpeg returns is checked against
 * it, so a variable-rate stream is refused rather than misread.
 *
 * Needs `ffmpeg` and `ffprobe` on the PATH, and `sharp` for frame encoding.
 */
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ClipDecoder, DecodedSound, ShownFrame } from '@lloyal-labs/media';
import { encodeVideoFrame } from '@lloyal-labs/media/node';

/** What the probe found. Each of picture and sound names its stream, and every decode maps that stream: ffmpeg's
 *  own choice (the default-flagged, the largest, the most channels) can be another, read at the wrong rate. */
interface Probed {
  durationS: number;
  picture?: { stream: number; width: number; height: number; startS: number; rate: number };
  sound?: { stream: number; startS: number; sampleRate: number; channels: number };
}

/** Half a millisecond: how far before a frame's time a seek starts, so float rounding never lands on the next one. */
const SEEK_LEAD_S = 0.0005;

/** `num/den` as ffprobe writes a rate. */
const rational = (r: string): number => { const [num, den] = r.split('/').map(Number); return num / den; };

export function ffmpegDecoder(file: string): ClipDecoder {
  const running = new Set<ChildProcess>();
  let disposed = false;

  /** Run ffmpeg or ffprobe to completion; disposing kills it, and its promise rejects. */
  const run = (tool: 'ffmpeg' | 'ffprobe', args: string[]): Promise<{ stdout: Buffer; stderr: string }> => {
    if (disposed) return Promise.reject(new Error('the decoder was disposed'));
    return new Promise((resolve, reject) => {
      const child = execFile(tool, args, { encoding: 'buffer', maxBuffer: 1 << 30 }, (error, stdout, stderr) => {
        running.delete(child);
        if (error) reject(new Error(`${tool} failed: ${disposed ? 'the decoder was disposed' : stderr.toString().trim() || error.message}`));
        else resolve({ stdout, stderr: stderr.toString() });
      });
      running.add(child);
    });
  };

  const probed: Promise<Probed> = run('ffprobe', [
    '-v', 'error', '-of', 'json',
    '-show_entries', 'format=duration:stream=index,codec_type,width,height,r_frame_rate,start_time,sample_rate,channels', file,
  ]).then(({ stdout }) => {
    const { format, streams } = JSON.parse(stdout.toString()) as {
      format: { duration: string };
      streams: {
        index: number; codec_type: string; width?: number; height?: number; r_frame_rate: string; start_time?: string;
        sample_rate?: string; channels?: number;
      }[];
    };
    const video = streams.find(s => s.codec_type === 'video');
    const audio = streams.find(s => s.codec_type === 'audio');
    return {
      durationS: Number(format.duration),
      ...(video ? { picture: { stream: video.index, width: video.width!, height: video.height!, startS: Number(video.start_time ?? 0), rate: rational(video.r_frame_rate) } } : {}),
      ...(audio ? { sound: { stream: audio.index, startS: Number(audio.start_time ?? 0), sampleRate: Number(audio.sample_rate), channels: audio.channels! } } : {}),
    };
  });
  probed.catch(() => {});

  const picture = async () => {
    const { picture } = await probed;
    if (!picture) throw new Error('ffmpeg found no picture in that file.');
    return picture;
  };

  /** The frame shown at `t`: the last whose time is at or before it, decoded, scaled to `size` and encoded as a video frame. */
  async function frameAt(t: number, size: { width: number; height: number }): Promise<ShownFrame | null> {
    const { stream, startS, rate } = await picture();
    const shownS = startS + Math.floor((t - startS) * rate + 1e-6) / rate;
    const { stdout, stderr } = await run('ffmpeg', [
      '-v', 'info', '-ss', Math.max(0, shownS - SEEK_LEAD_S).toFixed(6), '-i', file, '-map', `0:${stream}`, '-frames:v', '1', '-copyts',
      '-vf', `scale=${size.width}:${size.height},showinfo`, '-f', 'image2pipe', '-c:v', 'png', '-',
    ]);
    // Past the last frame nothing is shown.
    if (stdout.length === 0) return null;
    const decodedS = Number(/pts_time:([\d.]+)/.exec(stderr)?.[1]);
    if (!(Math.abs(decodedS - shownS) < 0.001)) {
      throw new Error(`ffmpeg decoded the frame at ${decodedS} s for ${shownS} s: this decoder reads constant-rate pictures only`);
    }
    return { shownS: decodedS, bytes: await encodeVideoFrame(new Uint8Array(stdout)) };
  }

  return {
    duration: async () => (await probed).durationS,
    picture,
    async *frames(times, size) {
      for (const t of times) yield await frameAt(t, size);
    },
    async *sound(): AsyncGenerator<DecodedSound> {
      const { sound } = await probed;
      if (!sound || disposed) return;
      // The sound as it decodes: interleaved 32-bit floats at the source's own rate and channels.
      const child = spawn('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:${sound.stream}`, '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      running.add(child);
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      const exited = new Promise<number | null>(resolve => child.on('close', resolve));
      const frameBytes = 4 * sound.channels;
      let carry = Buffer.alloc(0);
      let samples = 0;
      try {
        for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
          const bytes = Buffer.concat([carry, chunk]);
          const whole = Math.floor(bytes.length / frameBytes);
          carry = bytes.subarray(whole * frameBytes);
          const interleaved = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + whole * frameBytes));
          const channels = Array.from({ length: sound.channels }, (_, c) => Float32Array.from({ length: whole }, (_, i) => interleaved[i * sound.channels + c]));
          yield { shownS: sound.startS + samples / sound.sampleRate, sampleRate: sound.sampleRate, channels };
          samples += whole;
        }
        const code = await exited;
        // A stopped decode rejects, as the contract says, so it is never mistaken for the end of the sound.
        if (disposed) throw new Error('the decoder was disposed');
        if (code !== 0) throw new Error(`ffmpeg failed: ${stderr.trim()}`);
      } finally {
        running.delete(child);
        child.kill();
      }
    },
    dispose() {
      disposed = true;
      for (const child of running) child.kill();
    },
  };
}
