# __NAME__

A grounded multi-agent research harness. The models live *inside* the app — no
API key, and nothing on the inference path touches the network. Given a question
it runs a pre-flight recon probe of each source, plans a set of research tasks, and
dispatches a pool of agents that gather evidence in parallel (or in a dependency
chain), then synthesizes one cited answer.

> **SNAPSHOT: reasoning.run @ 0.8.0.** This template is a curated separate copy of
> reasoning.run's RACE/DRB-tuned pipeline, conforming to the `harness.dev new`
> conventions — a real, editable starter, not a dependency. Drift from upstream is
> expected.

## Run it

```sh
npm install
npm start
```

Two models are fetched and **digest-verified** on first run — no key: the reasoning
LLM into `models/llm/`, and the reranker the sources score retrievals with into
`models/reranker/`. (Prefer your own weight? Drop a `.gguf` in the role folder, or
point a `path:` in `harness.yml` at one.) `npm start` opens a terminal UI; type a
question and watch recon → plan → agents → synth run on-device.

`npm start` builds with **esbuild** (`--loader:.eta=text`) rather than plain `tsc`,
because the harness inlines the tuned prompt templates from `prompts/*.eta`.

The SAME harness runs on two more surfaces — same `harness(ctx, events, commands)`,
same `reduce`, a different binding:

```sh
npm run dev:desktop   # a native window (Electron): forks this cli as the engine
npm run serve         # a local host serving browsers over ws://127.0.0.1:8787
npm run dev:web       # …and the browser app that talks to it (Vite, :5173)
```

## The shape

```
harness/
  harness.ts     ← the one file that's yours: the command loop + app boot
  pipeline.ts    the tuned recon → plan → research → synth pipeline + policies
  protocol.ts    the events (↓) and commands (↑) your harness speaks
  state.ts       node-free reduce(events) → AppState (every view folds it)
  runner-ctx.ts  this harness's edge Runner seam (config + lifecycle) — RunnerCtx
  served-runtime.ts  the edge/served Runner factories + per-session model context
  served-session.ts  the served (web) per-session boot: provision services → run harness
prompts/         the 7 RACE/DRB-tuned .eta prompts — edit one to override it
targets/
  cli/
    index.ts     boot: resolve the models, mount a view, run your harness
    view.tsx     the terminal view (Ink) — swap it, or bring a whole app
  desktop/       the same harness in a native window (Electron + ipc binding)
    App.tsx      the shared React view (desktop + web) — folds the same reduce
  web/           a local host (serve.ts) + browser app, over the wss binding
models/
  llm/           the resident reasoning model (fetched on first run; gitignored)
  reranker/      the resident cross-encoder      (fetched on first run; gitignored)
harness.yml      targets + models
```

Everything under `targets/` is convention handled for you. The center —
`harness/harness.ts` + `harness/pipeline.ts` — is where you program what your
intelligence does. Drop a `prompts/<name>.eta` into the tree to override any tuned
prompt; an empty `prompts/` is byte-identical to the baked defaults.

## Add capabilities

```sh
npx harness.dev install <publisher>/<name>   # a signed AgentApp from apps.lloyal.ai
```

Enable it in `harness/harness.ts` by adding its factory to `apps`.
