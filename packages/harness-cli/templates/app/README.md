# __NAME__-app

HDK app scaffolded by `harness.dev app __NAME__`. Demonstrates the App protocol with a search + fetch tool pair. Out of the box the tools call Wikipedia's public REST so you can run + test the app end-to-end before customizing — replace the tool bodies with your real __NAME__ integration.

## First run

```bash
npm install
npm run build
npm test    # writes to be added in test/
```

## File map

| File | What to edit |
|---|---|
| `app.json` | `useWhen` (replace the `EDIT THIS` placeholder with a one-sentence description of when the planner should route to your app). Tool names if you rename them. |
| `skill.eta` | The per-spawn skill template — describes how an agent should approach __NAME__ subtasks. |
| `src/source.ts` | The Source class. Add fields if your tools share state (e.g., a cached client). |
| `src/tools/search.ts` | Replace the Wikipedia opensearch call with your __NAME__ search backend. Keep the schema + return shape. |
| `src/tools/fetch.ts` | Replace the Wikipedia REST call with your __NAME__ detail fetch. Keep the schema + return shape. |
| `package.json` | Set `name` to your published npm package name (e.g., `@yourpublisher/__NAME__-app`). |

## Protocol cheatsheet

- Tools subclass `Tool<TArgs>` from `@lloyal-labs/lloyal-agents`. The class properties `name`, `description`, `parameters`, and `protected` are read at registration time. The generator method `execute(args)` is the dispatch body; yield `call(asyncFn)` from `effection` for I/O.
- The Source subclass exposes `name` + `tools[]`. The framework registers each tool by its `name`.
- The factory (`create__NAME_PASCAL__App`) is a zero-arg generator that reads the manifest, constructs the source, and calls `defineApp(...)`.

## Publishing

When the app is ready to ship:

```bash
npm version 1.0.0      # or whatever version
harness.dev publish    # submit to apps.lloyal.ai for review
```

See the [CLI publishing docs](https://docs.lloyal.ai/cli/publishing) for the full review flow.
