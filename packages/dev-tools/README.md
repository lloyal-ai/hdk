# @lloyal-labs/dev-tools

The dev pane for scaffolded harnesses. A cog appears when the harness runs
under `LLOYAL_DEV=1`; it opens a docked pane — Timeline, Sources, Settings —
fed entirely by the event bus the harness already emits. Nothing ships to end
users: without the dev signal the components render nothing.

- `@lloyal-labs/dev-tools` — the node-free model: event folding, control
  tables, provenance vocabulary.
- `@lloyal-labs/dev-tools/react` — `<DevPane>`, mounted once beside the
  shared React view (desktop + web).
- `@lloyal-labs/dev-tools/ink` — `<DevOverlay>`, a bounded ctrl+g overlay for
  the terminal view.

The harness itself never imports this package — the pane is a sink on the
bus, and the commands it dispatches are the same ones the composer already
sends.
