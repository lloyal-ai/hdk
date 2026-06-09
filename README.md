# lloyal HDK

[![CI](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml/badge.svg)](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml)
[![GPU Tests](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml/badge.svg)](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml)
[![npm agents](https://img.shields.io/npm/v/@lloyal-labs/lloyal-agents.svg?label=lloyal-agents)](https://www.npmjs.com/package/@lloyal-labs/lloyal-agents)
[![npm sdk](https://img.shields.io/npm/v/@lloyal-labs/sdk.svg?label=sdk)](https://www.npmjs.com/package/@lloyal-labs/sdk)
[![License](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg)](LICENSE)

**Full-stack agentic AI for llama.cpp. One Node process — no inference server, no Docker, no vector DB, no glue code.**

Most agent stacks are infrastructure: an inference server, an agent runtime, a vector store, embedding pipelines, glue code — wired together over HTTP and shipped as a Docker compose. HDK collapses that into a single Node process you can embed in a desktop app, bundle in a CLI, deploy to a serverless function, or anywhere Node runs.

Agents are branches of a live llama.cpp KV cache, scheduled under structured concurrency, with tools that prefill results directly into the model's attention state — same process, same memory, same data structures as the rest of your code.

<p>
  <img src="assets/demo-readme.gif" alt="Deep Research: 5 agents researching concurrently inside a shared 32K-token context window, plan → research with tool calls → synthesize" width="100%">
  <br>
  <em>Qwen3.5 4B + Qwen3 0.6B reranker · 5 parallel agents · shared 32K context · fully offline on M2 MacBook Pro 16 GB</em>
</p>

> The demo above is [**reasoning.run**](https://www.npmjs.com/package/reasoning.run), a deep-research CLI built with HDK. Try it in 30 seconds: `npx reasoning.run`.

## Stack vs. imports

The honest comparison is full stack against full stack. Each row of the right column is a service to install, configure, version, secure, and orchestrate. Each row of the left column is an import.

| Typical agent stack                                             | HDK                                   |
| --------------------------------------------------------------- | ------------------------------------- |
| Inference server (vLLM / Ollama / llama-server)                 | `@lloyal-labs/lloyal.node`            |
| Agent runtime (LangChain / LangGraph / AutoGen / CrewAI)        | `@lloyal-labs/lloyal-agents`          |
| Vector DB (Pinecone / Weaviate / pgvector) + embedding pipeline | `Source` contract — sources are tools |
| Retrieval orchestration (Haystack / LlamaIndex)                 | `@lloyal-labs/rig`                    |
| Process orchestrator (Docker compose / Kubernetes / Airflow)    | TypeScript scopes (Effection)         |
| Glue code                                                       | `npm i`                               |

## What you get

- **Structured Concurrency.** Agents bind to parent scopes via [Effection](https://frontside.com/effection); cancellation propagates, teardown runs in reverse. The model that powers Kotlin coroutines, Swift Tasks, Java Project Loom, and C++26 — applied to GPU-native agents.
- **Continuous-Context Agents.** Agents share GPU state, not strings. Forks are O(1), zero tensor copy — sub-agents inherit the parent's full attention state instead of re-encoding lossy summaries. **4.4× fewer tokens processed** than a prompt-rebuilding approach.
- **Retrieval-Interleaved Generation.** Agents assemble context _during_ generation — searching, reading, and reranking across your app's own data. One `Source` shape for files, SQL, the web, or user records. A cross-encoder focal lens admits only verbatim top-K chunks — never summarized.

Mechanics, receipts, and the case for the architecture at [hdk.lloyal.ai](https://hdk.lloyal.ai).

## Requirements

- **Node 22+**
- **A GGUF model file on disk** — any model supported by llama.cpp
- macOS / Linux / Windows on x64 or arm64. CPU works; CUDA / Metal / Vulkan supported via prebuilt native binaries.

## Install

```bash
npm i @lloyal-labs/lloyal-agents @lloyal-labs/lloyal.node @lloyal-labs/rig
```

| Package         | Role                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `lloyal-agents` | Agent runtime — tick loop, orchestrators, policy, App protocol primitives                                                     |
| `lloyal.node`   | Native binding for llama.cpp ([liblloyal](https://github.com/lloyal-ai/liblloyal)); prebuilt for 13 platform/GPU combinations |
| `rig`           | App protocol helpers + retrieval providers — `defineApp`, `createAppRegistry`, `PlanTool`, `DelegateTool`, `reportTool`       |

`harness.dev` (the CLI for scaffolding harnesses + Apps, and for publishing / installing signed Apps) is a separate Apache-licensed package — install only when you need it:

```bash
npm i -g harness.dev
```

## Apps — the unit of capability

In HDK 3.0 a capability is shipped as an **App**: a Source + Tools + per-spawn skill template + manifest, validated by `defineApp` and registered into the runtime by `createAppRegistry`. Apps are distributed as signed npm tarballs through `apps.lloyal.ai`, installed with `harness.dev install <publisher>/<name>`, and imported the standard way.

Two reference Apps ship first-party — `lloyal/web` (web search + page fetch) and `lloyal/corpus` (local-doc grep + read + semantic search). A third, `lloyal/wikipedia`, is the auth-free demo backend the scaffolders use.

Build your own:

```bash
npx harness.dev app jira --publisher acme
```

The scaffold ships with a working source + two tools calling Wikipedia's REST API as the demo backend. Swap the bodies for your real backend, then publish:

```bash
npx harness.dev publish
```

## Quickstart

Embed the runtime + run a one-shot research agent against an installed App. No vector DB to provision, no retrieval orchestration — `lloyal/wikipedia` ships preinstalled with the harness scaffold and resolves with no auth.

```typescript
import { main, call } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import { initAgents, useAgent } from "@lloyal-labs/lloyal-agents";
import {
  createAppRegistry,
  createInMemoryConfigStore,
  reportTool,
} from "@lloyal-labs/rig";
import { createWikipediaApp } from "@lloyal-labs/wikipedia-app";

main(function* () {
  const ctx = yield* call(() =>
    createContext({
      modelPath: "model.gguf",
      nCtx: 32768,
      nSeqMax: 8,
      typeK: "q4_0",
      typeV: "q4_0",
    }),
  );
  yield* initAgents(ctx);

  // Enable an App — its Tools, Source, and skill template get
  // auto-wired into the agent runtime through the registry.
  const configStore = createInMemoryConfigStore();
  const registry = yield* createAppRegistry({ configStore });
  const wikipedia = yield* registry.enable(createWikipediaApp);

  const a = yield* useAgent({
    systemPrompt: "You are a research assistant.",
    task: "Who founded the city of Brasília, and when?",
    tools: [...wikipedia.tools, reportTool],
    terminalToolName: "report",
  });

  console.log(a.result);
});
```

For multi-app harnesses, swap `parallel` / `chain` / `fanout` / `dag` orchestrators around an `agentPool` to reshape execution without changing the call. The `examples/` directory has runnable patterns; for a full TUI harness, run `npx harness.dev <name>`.

## Public API

```typescript
// Agent runtime
import {
  initAgents,
  useAgent,
  agent,
  agentPool,
  useAgentPool,
  diverge,
  parallel,
  chain,
  fanout,
  dag,
  reduce,
  withSpine,
  Tool,
  Source,
  DefaultAgentPolicy,
  Ctx,
  Store,
  Events,
  AppRegistryCtx,
  AppConfigStoreCtx,
  GrantStoreCtx,
  RerankerCtx,
} from "@lloyal-labs/lloyal-agents";

// App protocol + framework tools
import {
  defineApp,
  createAppRegistry,
  createInMemoryConfigStore,
  createGrantStore,
  renderSpine,
  renderAgentPreamble,
  reportTool,
  PlanTool,
  DelegateTool,
  TavilyProvider,
  createKeylessSearchProvider,
  verifyBundle,
  CHANNEL_TRUST_ROOTS,
} from "@lloyal-labs/rig";
```

That is essentially the framework.

## Repo layout

```
packages/
  agents/        @lloyal-labs/lloyal-agents — agent runtime + App protocol primitives
  sdk/           @lloyal-labs/sdk           — inference primitives (Branch, Session, Rerank)
  rig/           @lloyal-labs/rig           — App protocol helpers + retrieval providers + framework tools
  apps/
    web/         @lloyal-labs/web-app       — first-party web research App
    corpus/      @lloyal-labs/corpus-app    — first-party local-corpus research App
    wikipedia/   @lloyal-labs/wikipedia-app — first-party Wikipedia demo App
  harness-cli/   harness.dev                — scaffolding + publish + install + review CLI

examples/
  react-agent/   Single agent with corpus tools — `useAgent` baseline
  reflection/    Research → draft → critique → revise via `diverge`
  compare/       DAG primer: parallel research → compare → synthesize
```

The native binding [`@lloyal-labs/lloyal.node`](https://github.com/lloyal-ai/lloyal.node) lives in a separate repo and is pulled in as a dependency.

## Compatibility

GPU integration tests run against six architectures and chat-template families on every PR:

| Model                 | Params | Quant  | Template |
| --------------------- | ------ | ------ | -------- |
| SmolLM2-1.7B-Instruct | 1.7B   | Q4_K_M | ChatML   |
| Llama-3.2-1B-Instruct | 1B     | Q4_K_M | Llama 3  |
| Phi-3.5-mini-instruct | 3.8B   | Q4_K_M | Phi 3    |
| Qwen3-4B-Thinking     | 4B     | Q4_K_M | ChatML   |
| gemma-3-1b-it         | 1B     | Q4_K_M | Gemma    |
| GLM-Edge              | —      | Q4_K_M | GLM-Edge |

The native backend ships prebuilt binaries across 13 platform/GPU combinations:

| Platform    | arm64             | x64               |
| ----------- | ----------------- | ----------------- |
| **macOS**   | Metal             | CPU               |
| **Linux**   | CPU, CUDA, Vulkan | CPU, CUDA, Vulkan |
| **Windows** | CPU, Vulkan       | CPU, CUDA, Vulkan |

## Development

```bash
git clone https://github.com/lloyal-ai/hdk
cd hdk
npm install
npm run build       # tsc -b across workspace
npm test            # unit tests
```

Every PR runs build, typecheck, and unit tests on CI, plus a cross-repo GPU integration job: HDK PRs trigger [`lloyal-node`](https://github.com/lloyal-ai/lloyal.node)'s GPU workflow, which builds the PR's packages against the native runtime on NVIDIA L4 hardware and runs the full agent integration suite before merge.

## Docs

- **What HDK is and why** → [hdk.lloyal.ai](https://hdk.lloyal.ai)
- **Learn, reference, guides** → [docs.lloyal.ai](https://docs.lloyal.ai)
- **API reference** — TypeDoc-generated from source

## License

You can build and sell commercial products using HDK.

HDK 3.0 runtime packages (`@lloyal-labs/lloyal-agents`, `@lloyal-labs/sdk`,
`@lloyal-labs/rig`, `@lloyal-labs/corpus-app`, `@lloyal-labs/web-app`) are
source-available under FSL-1.1-Apache-2.0 and convert to Apache 2.0 two
years after each release. The restriction is narrow: you cannot offer a
competing HDK runtime, managed HDK service, or alternative HDK App
distribution channel. The canonical App distribution channel is
`apps.lloyal.ai` — every listed App is reviewed by Lloyal Labs for
tool-safety and manifest conformance, so consumers get a single AI-safety
boundary across every HDK harness and the App protocol does not fragment
into incompatible sub-catalogs.

`packages/harness-cli` (the `harness.dev` CLI) is licensed separately under
Apache 2.0 — see its own `LICENSE` file.

See [`LICENSE-FAQ.md`](./LICENSE-FAQ.md) for concrete examples of what's
permitted and what's restricted. See [`LICENSE`](./LICENSE) for the legal
text and [`NOTICE`](./NOTICE) for attribution.
