/**
 * The pane's host-resources sampler — the ONLY node-bound entry in
 * dev-tools. A dev-gated boot starts it beside the trace writer and sends
 * each sample onto the harness event channel; the pane overlays the series
 * on the pressure strip, so machine pressure and model pressure read on
 * one axis.
 *
 * GPU is deliberately absent: neither Metal nor CUDA exposes a
 * utilization number to an unprivileged process portably — honest
 * omission over a fake gauge.
 */
import os from 'node:os';
import type { HostResourcesEvent } from './index.js';

export type { HostResourcesEvent } from './index.js';

/** Start sampling; returns the stop function. The timer is unref'd so it
 *  never holds the process open. */
export function startHostResources(
  send: (ev: HostResourcesEvent) => void,
  intervalMs = 2000,
): () => void {
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  const cores = Math.max(1, os.cpus().length);
  const timer = setInterval(() => {
    const cpu = process.cpuUsage();
    const at = Date.now();
    const busyUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
    const wallUs = Math.max(1, (at - lastAt) * 1000);
    lastCpu = cpu;
    lastAt = at;
    send({
      type: 'host:resources',
      cpuPct: Math.min(100, Math.round((busyUs / (wallUs * cores)) * 100)),
      rssMb: Math.round(process.memoryUsage.rss() / 1_048_576),
      sysMemPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
