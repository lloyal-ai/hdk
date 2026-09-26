# Rig invariants

The rules the service and ability contracts promise, held as named scenarios rather than as regression
rows. `packages/agents/test/invariants` does this for the pool's lifecycle; this directory does it for what
rig owns: the registry, the settings group, the install, the services. A regression row pins a case that
broke once. A scenario states what the platform promises for a shape of use, and is written red — before
the mechanism — whenever the promise is new.

## Layout

- `harness.ts` — `world(spec)`: a runner, a real registry and store, the settings group over them, and
  `startRun()`, a run that takes its sources through `participating()` in a scope the scenario ends; plus
  `numberedAbility`, a factory whose every enable is numbered and owns a scope with an observable teardown —
  the shape of a real ability (a pacer, an index).
- `scenarios/*.scenario.test.ts` — concrete walkthroughs with explicit expectations, one promise each.

## Catalog

- **R1 — a configuration change applies without refusal.** A save while a run is live persists, stores and
  announces, exactly as one with no run does. Nothing about timing is refused, and nothing asks.
- **R2 — a name resolves to its current entry.** `byName` and `enabled` answer one handle per name for
  the registry's life; the handle's `tools`, `source` and `skill` forward to the entry the last save
  built.
- **R3 — a holder keeps what it took.** A scope that took its sources holds their NAMES: a tool object
  dereferenced before a save (an agent's spread at spawn) keeps answering, on the entry it took, and so does one
  dereferenced after — every entry enabled under a held name while the hold is open, by a save or before a
  disable, lives until the scope ends. A value a tool reads at the call — its ability's stored config — follows
  the store, not the entry; that is the ability's side (the web ability's tests hold it for the search key).
- **R4 — teardown when the last holder ends.** A superseded entry's scope ends once, when the last run holding
  its name ends; an entry nothing holds ends at once.
- **R5 — a failed rebuild changes nothing.** A factory that refuses its new configuration under a run leaves
  the current entry serving, restores the stored config, and says why.

Scenarios: `ability-reconfigured-under-a-run` (R1–R4), `ability-rebuild-fails-under-a-run` (R5).

## Running

```bash
npx vitest run packages/rig/test/invariants/
```
