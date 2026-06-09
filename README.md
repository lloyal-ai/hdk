# lloyal HDK

[![CI](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml/badge.svg)](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml)
[![GPU Tests](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml/badge.svg)](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml)
[![License](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg)](LICENSE)
[![Commercial Use](https://img.shields.io/badge/commercial%20use-unrestricted-brightgreen.svg)](#why-fsl-instead-of-mit)

**In-app intelligence — AI as a feature of your application, not an API call.**

*Full-stack agentic AI framework for [llama.cpp](https://github.com/ggml-org/llama.cpp).*

HDK agents are branches of a live llama.cpp KV cache running inside your Node process — same process, same memory, same data structures as the rest of your code. Tools prefill results directly into the model's attention state under structured concurrency. No inference server, no vector DB, no embedding pipeline, no permission proxy, no context assembler. The agent is already where the context lives.

Forking a sub-agent inherits the parent's full attention state at zero tensor copy: **4.4× fewer tokens processed** than prompt-rebuilding approaches, **O(1) spawns**, agent lifetimes bound to your application's scopes. Embed it in a desktop app, bundle in a CLI, deploy to a serverless function — anywhere Node runs.

Free to use, embed, ship, and sell — commercial, private, internal, all of it. The one carve-out — forking the runtime to compete — is the [trust boundary](#why-fsl-instead-of-mit) that keeps capability-bearing apps installable safely. Converts to Apache 2.0 on a rolling two-year schedule.

<p>
  <img src="assets/demo-readme.gif" alt="Deep Research: 5 agents researching concurrently inside a shared 32K-token context window, plan → research with tool calls → synthesize" width="100%">
  <br>
  <em>Qwen3.5 4B + Qwen3 0.6B reranker · 5 parallel agents · shared 32K context · fully offline on M2 MacBook Pro 16 GB</em>
</p>

> The demo above is [**reasoning.run**](https://www.npmjs.com/package/reasoning.run), a deep-research CLI built with HDK. Try it in 30 seconds: `npx reasoning.run`.

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

## Build a harness

A **harness** is your application with embedded HDK agents — the runnable product you ship to a user. It owns model boot, App registration via `createAppRegistry`, orchestrator topology (`parallel` / `chain` / `fanout` / `dag`), and event handling. Every developer using HDK ships a harness: a CLI like [`reasoning.run`](https://www.npmjs.com/package/reasoning.run), a desktop app's research mode, a serverless function, your existing Node app's AI feature.

### Scaffold (recommended)

```bash
npx harness.dev my-harness
cd my-harness && npm install
npm run dev "Who founded Brasília?"
```

The scaffold ships preinstalled with the `lloyal/wikipedia` App (no auth, runs against Wikipedia's public REST) so `npm run dev` works on first command. Edit `src/main.ts` to add real Apps via `harness.dev install <publisher>/<name>`.

### Embed in an existing project

```bash
npm i @lloyal-labs/lloyal-agents @lloyal-labs/lloyal.node @lloyal-labs/rig
npx harness.dev install lloyal/wikipedia   # or lloyal/web, lloyal/corpus, acme/...
```

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

  // Enable an App — its Tools, Source, and skill template
  // wire into the runtime through the registry.
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

For multi-app harnesses, swap `parallel` / `chain` / `fanout` / `dag` orchestrators around an `agentPool` to reshape execution without changing the call.

## Extend your harness

Capabilities — web search, browser automation, payment connectors, your company's data — live in **Apps**: signed, reviewed bundles installed from the channel at [`apps.lloyal.ai`](https://apps.lloyal.ai). An App wraps a Source + Tools + per-spawn skill template + manifest, validated by `defineApp`. Three reference Apps ship first-party: `lloyal/web` (web search + page fetch), `lloyal/corpus` (local-doc grep + read + semantic search), and `lloyal/wikipedia` (the auth-free demo backend the scaffolder uses).

```bash
npx harness.dev install lloyal/web         # install a reviewed capability
npx harness.dev install lloyal/corpus
```

Shipping a capability of your own — a vertical API, your company's internal data, a browser-automation runtime — means publishing an App through the channel for other harnesses to install:

```bash
npx harness.dev app jira --publisher acme  # scaffold an App
npx harness.dev publish                    # ship through the signed channel
```

## Stack vs. imports

The honest comparison is full stack against full stack. Each row of the right column is a service to install, configure, version, secure, and orchestrate. Each row of the left column is an import.

| Typical agent stack                                             | HDK                                   |
| --------------------------------------------------------------- | ------------------------------------- |
| Inference server (vLLM / Ollama / llama-server)                 | `@lloyal-labs/lloyal.node`            |
| Agent runtime (LangChain / LangGraph / AutoGen / CrewAI)        | `@lloyal-labs/lloyal-agents`          |
| Vector DB (Pinecone / Weaviate / pgvector) + embedding pipeline | Apps (`@lloyal-labs/web-app`, `@lloyal-labs/corpus-app`, your own) |
| Retrieval orchestration (Haystack / LlamaIndex)                 | `@lloyal-labs/rig`                    |
| Process orchestrator (Docker compose / Kubernetes / Airflow)    | TypeScript scopes (Effection)         |
| Glue code                                                       | `npm i`                               |

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
  compare/       DAG primer (App-protocol-shaped): parallel research → compare → synthesize
  react-agent/   Pre-App-protocol `useAgent` baseline (mechanism demo, not a 3.0 reference)
  reflection/    Pre-App-protocol `diverge` primer (research → draft → critique → revise)
```

`reasoning.run` is the production-grade 3.0 reference harness — `npx reasoning.run` and read its source. The native binding [`@lloyal-labs/lloyal.node`](https://github.com/lloyal-ai/lloyal.node) lives in a separate repo and is pulled in as a dependency.

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

## Why FSL instead of MIT?

HDK apps are **capability-bearing** — arbitrary code (browser automation, file access, payment connectors) bundled with skill instructions, running in shared inference context. OS sandboxing protects the machine; it does nothing about what an app's content reaches the model's attention. Cloud agent platforms can yank misbehaving extensions with a kill switch; HDK runs on user machines and can't.

Safety has to be **upstream and structural**: the canonical channel at [apps.lloyal.ai](https://apps.lloyal.ai) reviews and Ed25519-signs every App; the runtime verifies that signature against an embedded trust root at install. MIT doesn't preserve that — a fork could strip the trust root and ship to an unreviewed channel. FSL restricts one thing — that fork — to keep the trust root enforceable. It can't stop a determined bad actor; it keeps channel-switching from being the easy path.

## License

**Commercial use is unrestricted** — build and sell products with HDK, embed it in proprietary software, run it in production. The FSL restriction is narrow: you cannot ship a competing HDK runtime, managed HDK service, or alternative HDK App distribution channel.

HDK 3.0 runtime packages (`@lloyal-labs/lloyal-agents`, `@lloyal-labs/sdk`, `@lloyal-labs/rig`, `@lloyal-labs/web-app`, `@lloyal-labs/corpus-app`, `@lloyal-labs/wikipedia-app`) are source-available under FSL-1.1-Apache-2.0 and convert to Apache 2.0 two years after each release. `packages/harness-cli` (the `harness.dev` CLI) is Apache 2.0 from day one — see its own `LICENSE` file.

See [`LICENSE-FAQ.md`](./LICENSE-FAQ.md) for concrete examples of what's permitted and what's restricted, [`LICENSE`](./LICENSE) for the legal text, and [`NOTICE`](./NOTICE) for attribution.
