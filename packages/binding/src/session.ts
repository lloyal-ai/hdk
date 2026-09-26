/**
 * The session plane's vocabulary — the platform's third-person view of a Session,
 * authored by the box gateway and relayed by the transport.
 *
 * It is its own module because both sides of the wire need it and neither owns
 * it: the server-side `wss` binding posts it, the browser's bridge records it,
 * and the view derives from it. Nothing here imports anything.
 */

/**
 * The canonical, harness-agnostic Session lifecycle. The client renders it
 * (a queue position, a warming spinner, a banner over a preserved run on
 * `died`). It carries NO internal identifiers — no handle, no context, no KV
 * accounting.
 */
export type SessionState =
  | { phase: "parked" }
  | { phase: "queued"; position?: number }
  | { phase: "warming" }
  | { phase: "live" }
  | { phase: "draining" }
  | { phase: "died"; signal?: string; code?: number }
  | { phase: "reaped" };

/**
 * The **session-plane** frame — a sibling of `BindingFrame`, never a variant of it.
 * Carries the harness-agnostic {@link SessionState}, **authored by the box gateway**
 * (never by a harness) and relayed by the wss transport. Kept out of `BindingFrame`
 * so local bindings (render/ndjson/ipc) are never forced to understand remote
 * admission/residency.
 */
export type SessionFrame = { t: "session"; payload: SessionState };
