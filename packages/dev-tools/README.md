# @lloyal-labs/dev-tools

The dev pane for scaffolded harnesses. A slim status bar docks below the
app when the harness runs under `LLOYAL_DEV=1`; clicking it expands the
pane — Timeline, Sources, Settings — fed entirely by the event bus the
harness already emits.
Nothing ships to end users: without the dev signal, only the shell's plain
layout containers render — no cog, no pane, no listeners beyond the fold.

- `@lloyal-labs/dev-tools` — the node-free model: event folding, control
  tables, provenance vocabulary.
- `@lloyal-labs/dev-tools/react` — `<DevPane>`, the view's layout shell:
  wrap the shared React view in it once (desktop + web) —
  `<DevPane bridge={window.harness}><App/></DevPane>`. The app renders in
  the shell's scroll container and the pane docks below as its own flex
  region, so an open pane shrinks the app instead of covering it. Sizing
  contract: a full-height view uses `height: 100%` — never `100vh`/
  `100dvh`, which would push its bottom edge under the status bar.
- `@lloyal-labs/dev-tools/ink` — `<DevOverlay>`, a bounded ctrl+g overlay for
  the terminal view.
- `@lloyal-labs/dev-tools/node` — `startHostResources`, the host sampler a
  dev-gated Node boot starts beside its trace sink.

The harness itself never imports this package — the pane is a sink on the
bus, and the commands it dispatches are the same ones the composer already
sends.
