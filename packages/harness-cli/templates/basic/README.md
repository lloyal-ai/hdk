# __NAME__

A vertical inference harness. The model lives *inside* the app — no API key, and nothing on the inference path touches the network.

## Run it

```sh
npm install
```

Then start a surface — each folds the same harness:

__RUN_STEPS__

The recommended model is fetched and **digest-verified** into `models/llm/` on first run — no key. (Prefer your own weight? Drop a `.gguf` in `models/llm/`, or point `model.llm.path` in `harness.yml` at one.) Type a question and watch two agents research it in parallel while a synth combines their notes.

The **web** surface is two processes — a resident-model **host** and a browser client; `npm run dev:web` starts both (the browser reconnects until the host is up). To run the host on its own (a remote box, or the browser elsewhere), use `npm run serve` + `npm run dev:web:client`. For a fast cli loop without a build step, use `npm run dev`.

## The shape

```
harness/
  harness.ts     ← the one file that's yours: your program, as code
  protocol.ts    the events (↓) and commands (↑) your harness speaks
  state.ts       node-free reduce(events) → AppState (every view folds it)
targets/
  <surface>/     one dir per surface — cli · desktop · web
    index.ts     boot: resolve the model, mount a view, run your harness
    view.tsx     the view (Ink for cli, React for desktop/web) — or bring a whole app
models/
  llm/           the resident model (fetched on first run; gitignored)
vendor/          signed AgentApps — Ed25519-verified tarballs, committed
harness.yml      targets + model
```

Everything under `targets/` is convention handled for you — the boot mounts a view over a binding; a view is a sink that folds `reduce`. The center — `harness/harness.ts` — is where you program what your intelligence does: which agents exist, how they collaborate, what they trust, when work is done. `basic` runs a `parallel` pool + synth; `chain` is a one-line swap.

## Add capabilities

```sh
npx harness.dev install <publisher>/<name>   # a signed AgentApp from apps.lloyal.ai
```

Enable it in `harness/harness.ts` alongside `createWikipediaApp`.

Apps are **Ed25519-verified and vendored locally** — `harness.dev` fetches the
signed tarball, checks its signature, and writes it to `vendor/` with a `file:`
dependency (never a remote-URL install). Commit `vendor/` so `npm ci` reproduces
the exact bytes offline. If you scaffolded with `--skip-install`, fetch the
default app with `npx harness.dev install lloyal/wikipedia` before the first run.
