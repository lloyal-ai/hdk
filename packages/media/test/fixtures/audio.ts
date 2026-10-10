export function pcmWav(opts: { frames?: number; rate?: number; channels?: number; silent?: boolean } = {}): Uint8Array {
  const { frames = 160, rate = 16000, channels = 1, silent = false } = opts;
  const bytes = new Uint8Array(44 + frames * channels * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  if (!silent) view.setInt16(44, 8192, true);
  return bytes;
}
