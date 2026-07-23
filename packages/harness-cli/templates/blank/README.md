# __NAME__

A vertical inference harness. The model lives *inside* the app — there is no API key, and nothing on the inference path touches the network.

## Run it

```sh
npm install
# point harness.json at a local .gguf model file, then:
npm run dev "What was the Cuban missile crisis?"   # or just: npm start
```

`npm start` opens a terminal UI; type a question and watch two agents research it in parallel and a synth combine their notes.

## The shape

```
harness/
  harness.ts     ← the one file that's yours: your program, as code
  protocol.ts    the events (↓) and commands (↑) your harness speaks
  state.ts       how a view folds those events into renderable state
targets/
  cli.ts         run in a terminal (generated · rarely touched)
  cli-view.tsx   the terminal view
harness.json     model + settings
```

Everything under `targets/` is convention handled for you. The center —
`harness/harness.ts` — is where you program what your intelligence does: which
agents exist, how they collaborate, what evidence they trust, when work is done.

## Add capabilities

```sh
npx harness.dev install lloyal/corpus   # a signed AgentApp from apps.lloyal.ai
```

Enable it in `harness/harness.ts` alongside `createWikipediaApp`.
