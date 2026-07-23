# __NAME__

A vertical inference harness. The model lives *inside* the app — no API key, and nothing on the inference path touches the network.

## Run it

```sh
npm install
npm start
```

The recommended model is fetched and **digest-verified** into `models/llm/` on first run — no key. (Prefer your own weight? Drop a `.gguf` in `models/llm/`, or point `model.llm.path` in `harness.yml` at one.) `npm start` opens a terminal UI; type a question and watch two agents research it in parallel while a synth combines their notes. For a fast inner loop without a build step, use `npm run dev`.

## The shape

```
harness/
  harness.ts     ← the one file that's yours: your program, as code
  protocol.ts    the events (↓) and commands (↑) your harness speaks
  state.ts       node-free reduce(events) → AppState (every view folds it)
targets/
  cli/
    index.ts     boot: resolve the model, mount a view, run your harness
    view.tsx     the terminal view (Ink) — swap it, or bring a whole app
models/
  llm/           the resident model (fetched on first run; gitignored)
harness.yml      targets + model
```

Everything under `targets/` is convention handled for you — the boot mounts a view over a binding; a view is a sink that folds `reduce`. The center — `harness/harness.ts` — is where you program what your intelligence does: which agents exist, how they collaborate, what they trust, when work is done. `blank` runs a `parallel` pool + synth; `chain` is a one-line swap.

## Add capabilities

```sh
npx harness.dev install <publisher>/<name>   # a signed AgentApp from apps.lloyal.ai
```

Enable it in `harness/harness.ts` alongside `createWikipediaApp`.
