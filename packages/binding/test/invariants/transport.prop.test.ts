/**
 * Property test: the structural invariants (`predicates.ts`) hold for every
 * bidirectional transport across randomly-generated interleavings of harness
 * events, inbound commands, sink-failures, and teardown.
 *
 * This is the generic fault harness — rather than hand-picking the send-after-
 * close / drain-leak / half-open-dispatch cases one at a time (that is the
 * co-located regression tier), it enumerates thousands of orderings and asserts
 * the whole battery on each. A future refactor that reopens any seam fails here.
 */

import { describe, it } from "vitest";
import fc from "fast-check";
import {
  driveScript,
  wssProbe,
  ipcProbe,
  type Step,
  type ProbeAdapter,
} from "./harness";
import { checkAll, formatResult } from "./predicates";

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("event" as const), payload: fc.jsonValue() }),
  fc.record({ kind: fc.constant("command" as const), payload: fc.jsonValue() }),
  fc.constant({ kind: "failSink" as const }),
  fc.constant({ kind: "teardown" as const }),
);
const scriptArb = fc.array(stepArb, { maxLength: 12 });
const bootstrapArb = fc.array(fc.jsonValue(), { maxLength: 4 });

const PROBES: [string, ProbeAdapter, number][] = [
  ["wss", wssProbe, 400],
  // ipc mutates process globals per run (parentPort + keep-alive + listeners),
  // all balanced by driveScript's finally-teardown — fewer runs keeps it cheap.
  ["ipc", ipcProbe, 150],
];

describe.each(PROBES)(
  "transport invariants — %s",
  (_name, probe, numRuns) => {
    it("B1–B6 hold across random event/command/fail/teardown interleavings", () => {
      fc.assert(
        fc.property(bootstrapArb, scriptArb, (bootstrap, script) => {
          const run = driveScript(probe, script, bootstrap);
          const violations = checkAll(run);
          if (violations.length > 0) {
            throw new Error(formatResult({ ok: false, violations }));
          }
        }),
        { numRuns },
      );
    });
  },
);
