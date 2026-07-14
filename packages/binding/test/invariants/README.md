# Transport lifecycle invariants

This directory holds a property-based test and named scenarios that enforce the
**structural guarantees** of the binding's transports — the properties the source
comments claim, machine-checked. It mirrors `packages/agents/test/invariants/`.

## Two tiers

- **Specific regressions** live *beside the source* in `test/*.test.ts`
  (`adapters.test.ts`, `wss.test.ts`, `bus.test.ts`) and in the `@lloyal-labs/relay`
  package's `test/bridge.test.ts`. Each pins one fixed bug: a throwing sink is swallowed, the
  ndjson/wss subscriber detaches when the sink fails **during** `subscribe()`'s
  synchronous buffer drain (the window where `unsub` isn't assigned yet), etc.
- **Structural invariants** live here. They don't target a single bug — they
  assert the guarantee holds across *every* ordering, so a refactor that reopens
  a seam fails a machine check instead of passing because a mock hid it.

## Why this exists

Comments in the source like *"halt inbound too — no dispatch after teardown"* and
*"unsubscribe here or the bus leaks this connection's route closure"* state
invariants the code relies on. Before this directory those were enforced only by
developer discipline — seven rounds of external review on the reshape PR caught
exactly this class one line at a time. Enumerating the seams generically turns
"the reviewer will catch it" into "CI catches it".

## Layout

- `harness.ts` — `driveScript(probe, script, bootstrap)` attaches a bidirectional
  transport (`wssProbe`, `ipcProbe`) to an instrumented `EventBus`, replays a
  scripted sequence of harness-events / inbound-commands / sink-failures /
  teardown, and returns a `TransportRun` capturing every outbound frame, every
  dispatched command, whether anything threw, and the live subscriber count
  (the leak proxy).
- `predicates.ts` — named `Bn_*(run): PredicateResult`:
  - **B1** bootstrap events all precede the single trailing `ready`.
  - **B2** exactly one `ready`, ever.
  - **B3** no outbound frame after teardown.
  - **B4** the bus subscriber never leaks (0 attached after the final teardown).
  - **B5** a throwing outbound sink is always swallowed (never crashes the process).
  - **B6** no inbound command is dispatched after teardown.
- `transport.prop.test.ts` — `fast-check` drives ~550 random interleavings across
  `wss` + `ipc` and asserts the whole battery on each.
- `scenarios/*.scenario.test.ts` — concrete named walkthroughs the property can't
  express as a single-run predicate:
  - `wss-connectwss-loopback` — the real server transport wired to the real
    browser client; proves `serialize ∘ parse = identity` across the routed
    envelope (envelope drift would keep both isolated halves green).
  - `ipc-parent-disconnect` — the keep-alive is cleared on parent disconnect so a
    forked child never orphans.

## Scope

The property covers the **steady-state** seams (both probes seed bootstrap through
the bus *after* subscribing, so `ready` always comes). The **drain-window** eager
detach — buffered-before-subscribe events with an already-failing sink, where
`ready` never comes — and `ipc`'s deliberately different *inert-then-dispose*
detach are covered by the co-located regression tier, not folded into the uniform
battery (forcing uniformity there would false-positive on `ipc`).
