/**
 * @file A session's trace file, as an Effection resource.
 *
 * Split from the project content store it used to share a file with: the two
 * differ in location, gating and lifetime, and bundling them behind one
 * directory and one flag is what hid that difference.
 */
import { NullTraceWriter, JsonlTraceWriter } from '@lloyal-labs/lloyal-agents';
import type { TraceWriter } from '@lloyal-labs/lloyal-agents';
import { resource } from 'effection';
import type { Operation } from 'effection';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Open a session's trace file, closing it when the scope exits.
 *
 * A resource rather than a `{ writer, close }` pair: handing a caller a
 * `close()` to remember is exactly the cleanup-by-discipline that `resource()`
 * removes, and a forgotten one leaks a descriptor for the life of the process
 * — which on a served host means per session.
 *
 * **Tracing is observability, never a dependency.** `dev: false`, or any
 * failure to open, yields the Null writer rather than throwing: a harness that
 * cannot write a trace must still run. Deliberately unlike the content store
 * below, whose absence is a hard failure for media — see
 * {@link createProjectMediaStore}.
 *
 * The random id keeps concurrent writers apart and `"wx"` refuses to truncate
 * an existing file.
 *
 * @param outputDir - Where the trace lands (`sources.outputDir`). Created if
 *                    missing.
 * @param dev - False ⇒ the Null writer, at zero cost.
 *
 * @category Runtime
 */
export function useTraceWriter(outputDir: string, dev: boolean): Operation<TraceWriter> {
  return resource(function* (provide) {
    let fd: number | undefined;
    let writer: TraceWriter = new NullTraceWriter();
    if (dev) {
      try {
        mkdirSync(outputDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fd = openSync(join(outputDir, `trace-${ts}-${randomUUID().slice(0, 8)}.jsonl`), 'wx');
        writer = new JsonlTraceWriter(fd);
      } catch {
        // Tracing is observability, never a dependency: a harness that cannot
        // open a trace must still run.
        fd = undefined;
      }
    }
    try {
      yield* provide(writer);
    } finally {
      writer.flush();
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    }
  });
}
