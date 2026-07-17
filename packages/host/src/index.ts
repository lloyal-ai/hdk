/**
 * @lloyal-labs/host — the box model-runtime host.
 *
 * One resident model, N native harness sessions, FIFO admission. Harness-agnostic:
 * a caller injects a `ServedHarness` (materialise + run) and drives admission; the
 * host owns queue / cap / lifecycle / `SessionState` and imports no harness.
 */
export { createModelRuntimeHost } from "./host";
export type { ModelRuntimeHost } from "./host";
export type {
  SessionState,
  Materialised,
  ServedHarness,
  ModelRuntimeHostOpts,
  AdmissionRequest,
  NativeSessionRecord,
} from "./types";
