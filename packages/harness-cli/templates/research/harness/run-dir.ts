/**
 * Per-query artifact sink.
 *
 * Subscribes to the WorkflowEvent stream forwarded by main.ts's drain
 * and writes:
 *   <output-dir>/<ISO-timestamp>/
 *     report.md          — synth/passthrough answer with metadata + annexure index
 *     annexure-N.md      — one per research agent's `report` tool result
 *
 * Trace.jsonl is NOT this sink's concern. Trace is session-scoped: opened
 * once at boot in main.ts, captures every query (including warm follow-
 * ups), closed at process exit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowEvent } from './events.js';

export class RunDirSink {
  private currentDir: string | null = null;
  private inResearch = false;
  private spawnOrdinal = 0;
  private agentToOrdinal = new Map<number, number>();
  private taskByOrdinal = new Map<number, string>();
  private lastAnswer: string | null = null;
  private query: string | null = null;
  private mode: 'flat' | 'deep' | null = null;
  private startedAt: number | null = null;
  private synthStats: { tokens: number; ppl: number; timeMs: number } | null = null;

  /** Begin a new query's run-dir. Returns the absolute path so callers can
   *  emit a `ui:run_dir` event for the composer to display. */
  start(opts: { outputDir: string; query: string; mode: 'flat' | 'deep' }): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    this.currentDir = path.resolve(opts.outputDir, ts);
    fs.mkdirSync(this.currentDir, { recursive: true });
    this.inResearch = false;
    this.spawnOrdinal = 0;
    this.agentToOrdinal.clear();
    this.taskByOrdinal.clear();
    this.lastAnswer = null;
    this.query = opts.query;
    this.mode = opts.mode;
    this.startedAt = Date.now();
    this.synthStats = null;
    return this.currentDir;
  }

  handle(ev: WorkflowEvent): void {
    if (!this.currentDir) return;
    switch (ev.type) {
      case 'research:start':
        this.inResearch = true;
        break;
      case 'research:done':
        this.inResearch = false;
        break;
      case 'fanout:tasks':
        ev.tasks.forEach((t, i) => this.taskByOrdinal.set(i + 1, t.description));
        break;
      case 'spine:task':
        this.taskByOrdinal.set(ev.taskIndex + 1, ev.description);
        break;
      case 'agent:spawn':
        if (this.inResearch && !this.agentToOrdinal.has(ev.agentId)) {
          this.spawnOrdinal += 1;
          this.agentToOrdinal.set(ev.agentId, this.spawnOrdinal);
        }
        break;
      case 'agent:return':
      case 'agent:recovered': {
        const ord = this.agentToOrdinal.get(ev.agentId);
        if (ord !== undefined) this.writeAnnexure(ord, ev.result);
        break;
      }
      case 'answer':
        this.lastAnswer = ev.text;
        break;
      case 'synthesize:done':
        this.synthStats = {
          tokens: ev.tokenCount,
          ppl: ev.ppl,
          timeMs: ev.timeMs,
        };
        break;
      case 'complete':
        this.finish();
        break;
      case 'ui:error':
        // Failed mid-run — annexures already written, no report.md.
        // Trace is session-scoped so partial events are already persisted.
        this.reset();
        break;
    }
  }

  private writeAnnexure(n: number, body: string): void {
    if (!this.currentDir) return;
    const desc = this.taskByOrdinal.get(n) ?? '';
    const header = `# Annexure ${n}\n\n${desc ? `**Task:** ${desc}\n\n` : ''}---\n\n`;
    fs.writeFileSync(
      path.join(this.currentDir, `annexure-${n}.md`),
      header + body.trimEnd() + '\n',
      'utf8',
    );
  }

  private finish(): void {
    if (this.currentDir && this.lastAnswer && this.query) {
      const totalMs = this.startedAt ? Date.now() - this.startedAt : 0;
      const ords = [...this.agentToOrdinal.values()].sort((a, b) => a - b);
      const refs = ords
        .map((n) => {
          const desc = this.taskByOrdinal.get(n);
          return `- [Annexure ${n}](./annexure-${n}.md)${desc ? ` — ${desc}` : ''}`;
        })
        .join('\n');
      const stats = this.synthStats
        ? ` · ${this.synthStats.tokens} synth tokens · ppl ${this.synthStats.ppl.toFixed(2)}`
        : '';
      const meta = `> ${new Date().toISOString()} · ${this.mode}${stats} · ${(totalMs / 1000).toFixed(1)}s`;
      const annexureSection = refs
        ? `\n---\n\n## Annexures\n\n${refs}\n`
        : '';
      const body = `# ${this.query}\n\n${meta}\n\n${this.lastAnswer.trim()}\n${annexureSection}`;
      fs.writeFileSync(path.join(this.currentDir, 'report.md'), body, 'utf8');
    }
    this.reset();
  }

  private reset(): void {
    this.currentDir = null;
    this.inResearch = false;
    this.spawnOrdinal = 0;
    this.agentToOrdinal.clear();
    this.taskByOrdinal.clear();
    this.lastAnswer = null;
    this.query = null;
    this.mode = null;
    this.startedAt = null;
    this.synthStats = null;
  }
}
