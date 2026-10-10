declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** The audio thread owns the sample ceiling even if the renderer is busy. */
class PcmCapture extends AudioWorkletProcessor {
  private buffer = new Int16Array(2048);
  private used = 0;
  private frames = 0;
  private peak = 0;
  private finished = false;
  private readonly maxFrames: number;

  constructor(options: { processorOptions: { maxFrames: number } }) {
    super();
    this.maxFrames = options.processorOptions.maxFrames;
    this.port.onmessage = () => this.finish();
  }

  private flush(): void {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage({ samples, level: this.peak, elapsed: this.frames / sampleRate }, [samples.buffer]);
    this.used = 0; this.peak = 0;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage({ done: true });
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.finished) return false;
    const mono = inputs[0]?.[0];
    if (!mono) return true;
    for (const sample of mono) {
      if (this.frames >= this.maxFrames) { this.finish(); return false; }
      const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      this.buffer[this.used++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.peak = Math.max(this.peak, Math.abs(value));
      this.frames++;
      if (this.used === this.buffer.length) this.flush();
    }
    if (this.frames === this.maxFrames) this.finish();
    return !this.finished;
  }
}

registerProcessor('lloyal-pcm-capture', PcmCapture);
export {};
