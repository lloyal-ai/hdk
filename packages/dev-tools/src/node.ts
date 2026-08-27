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
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs';
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
    const ev: HostResourcesEvent = {
      type: 'host:resources',
      cpuPct: Math.min(100, Math.round((busyUs / (wallUs * cores)) * 100)),
      rssMb: Math.round(process.memoryUsage.rss() / 1_048_576),
    };
    if (lastMemUsedMb !== null) {
      ev.sysMemUsedMb = lastMemUsedMb;
      ev.sysMemTotalMb = Math.round(os.totalmem() / 1_048_576);
    }
    send(ev);
    readMemUsed((mb) => { lastMemUsedMb = mb; });
  }, intervalMs);
  timer.unref();
  let lastMemUsedMb: number | null = null;
  readMemUsed((mb) => { lastMemUsedMb = mb; });
  return () => clearInterval(timer);
}

/** Honest system-memory accounting, per platform. `os.freemem()` counts
 *  file cache as used on macOS AND Linux, pinning a naive gauge at ~99% —
 *  the exact misreporting this pane exists to kill. darwin: vm_stat's
 *  active+wired+compressed over total; linux: 1 − MemAvailable/total;
 *  anywhere else (or on any failure): null, and the strip omits the line —
 *  absence over a fake number. */
function readMemUsed(cb: (mb: number | null) => void): void {
  if (process.platform === 'darwin') {
    execFile('vm_stat', (err, out) => {
      if (err) return cb(null);
      const page = Number((out.match(/page size of (\d+)/) ?? [])[1]) || 16384;
      const pages = (re: RegExp): number => Number((out.match(re) ?? [])[1]) || 0;
      const used =
        (pages(/Pages active:\s+(\d+)/) +
          pages(/Pages wired down:\s+(\d+)/) +
          pages(/Pages occupied by compressor:\s+(\d+)/)) * page;
      cb(used > 0 ? Math.round(used / 1_048_576) : null);
    });
  } else if (process.platform === 'linux') {
    readFile('/proc/meminfo', 'utf8', (err, txt) => {
      if (err) return cb(null);
      const kb = Number((txt.match(/MemAvailable:\s+(\d+) kB/) ?? [])[1]);
      cb(Number.isFinite(kb) && kb > 0
        ? Math.round((os.totalmem() - kb * 1024) / 1_048_576)
        : null);
    });
  } else {
    cb(null);
  }
}
