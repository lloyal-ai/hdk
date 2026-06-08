# __NAME__

A research harness scaffolded by [`harness.dev`](https://www.npmjs.com/package/harness.dev).
Plans a query into orthogonal tasks, runs them in parallel against the
[`lloyal/wikipedia`](https://docs.lloyal.ai) app, and synthesizes the
findings into a single answer.

## Setup

```bash
npm install
```

You need a local `.gguf` model file. Point `harness.json` at it:

```json
{
  "model": {
    "path": "/path/to/your/model.gguf",
    "nCtx": 32768
  }
}
```

## Run

```bash
npm run dev "What was the Cuban missile crisis?"
```

Or via the compiled bin:

```bash
npm run build
./bin/run.js "What was the Cuban missile crisis?"
```

## What's inside

- `src/main.ts` — entry point. Loads the model, builds the app registry,
  enables the Wikipedia app, runs the query.
- `src/harness.ts` — the orchestrator. `runQuery` plans the query into
  tasks via `PlanTool`, fans the tasks out as parallel agents via
  `agentPool` + `parallel`, and reduces the reports into an answer via
  a synth `useAgent` call. The harness IS the orchestrator — there is
  no extra orchestrator agent.
- `prompts/plan.eta` — planner prompt (system + Eta-templated user body
  separated by `\n---\n`).
- `prompts/synth.eta` — synthesizer prompt, same format.

## Adding apps

Register additional apps in `src/main.ts`:

```ts
import { createCorpusApp } from "@lloyal-labs/corpus-app";

yield* configStore.set("corpus", { corpusPath: "/path/to/docs" });
yield* registry.enable(createCorpusApp);
```

Then install the app from the HDK channel:

```bash
npx harness.dev install lloyal/corpus
```

The planner will route each task to the most relevant app based on the
app's `useWhen` description.

## Scaffolding your own app

```bash
npx harness.dev app my-app
```

Replace the tool implementations with your backend. See
[docs.lloyal.ai](https://docs.lloyal.ai) for the App protocol.
