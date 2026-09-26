# Harness Development Kit

[![CI](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml/badge.svg)](https://github.com/lloyal-ai/hdk/actions/workflows/ci.yml)
[![GPU Tests](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml/badge.svg)](https://github.com/lloyal-ai/lloyal.node/actions/workflows/gpu-test.yml)
[![License](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg)](LICENSE)
[![Commercial Use](https://img.shields.io/badge/commercial%20use-unrestricted-brightgreen.svg)](#why-fsl-instead-of-mit)

**A harness is a tree of owned lifetimes governing a tree of live inference state.**

One model resident in the process. Agents forked from its context by a structured-concurrency runtime.
Specialist models bound beside it as services. Media addressed by content. One binding carrying the program
to every surface. This repository is the platform beneath [`lloyal-ai`](https://github.com/lloyal-ai/lloyal-ai),
the CLI that scaffolds a harness; the harness is a TypeScript program you own, and everything here is what
that program stands on.

```sh
npx lloyal-ai new my-app
```

<p>
  <img src="assets/three-agents-one-model.jpg" alt="Three agents on one model: the planner's lane ends in a plan, a spine of 794 tokens forks from it, and two research agents inherit the spine and search at once, while the context meter reads 13% of a 32k room" width="100%">
  <br>
  <em>Three agents on one model, in the dev pane of an app scaffolded from the deep-research template. The planner forks a spine; two researchers inherit it and search at once; the room is 13% used.</em>
</p>

## The stack

A harness programs intelligence over a branch-aware inference stack. Each layer establishes a different part
of the execution model, and every package in this repository hangs off one rung.

```
harness              your application: the procedure, the product, the domain rules   (scaffolded by lloyal-ai)
  ├─ @lloyal-labs/rig            the app runtime: abilities, services, retrieval, config, the boots, the serving stack
  ├─ @lloyal-labs/lloyal-agents  the agent runtime: agents, tools, policy, the pool, spines, orchestration, replay
  └─ @lloyal-labs/sdk            live inference-state primitives: Branch, BranchStore, Session, Rerank
       └─ @lloyal-labs/lloyal.node   the native binding — Node.js, desktop, server   (its own repository)
            └─ liblloyal              KV tenancy, branched inference, fork and prune, continuous tree batching
                 └─ llama.cpp         model loading, tokenisation, sampling, CPU and accelerator backends
```

[Effection](https://frontside.com/effection) is the structured-concurrency library underneath the runtime: it
gives application work an ownership tree, the way liblloyal gives inference a tree of live states. The HDK
aligns the two. Generators and `yield*` are the syntax of that lifetime model, not the architectural idea.
[Thinking in lloyal](https://docs.lloyal.ai/thinking-in-lloyal) is the whole account.

## The packages

> "Simplicity is hard work. But, there's a huge payoff. The person who has a genuinely simpler system — a
> system made out of genuinely simple parts — is going to be able to affect the greatest change with the least
> work."
> — Rich Hickey, *Simplicity Matters*, RailsConf 2012

Fifteen packages. Each does one thing, and the harness composes them.

| package | layer | what it is |
|---|---|---|
| `@lloyal-labs/sdk` | runtime | Backend-agnostic inference primitives over the native binding: `Branch`, `BranchStore`, `Session`, `Rerank`. The one layer that speaks to `lloyal.node`. |
| `@lloyal-labs/lloyal-agents` | runtime | The agent runtime: an `Agent` is a branch with intent, history and a result; the pool advances every agent a tick at a time over one shared KV cache; `withSpine` borrows live attention and returns durable findings; `AgentPolicy` decides at explicit boundaries; `parallel` / `chain` / `dag` orchestrate; replay reconstructs a branch from its record. Knows no tool but Delegate. |
| `@lloyal-labs/rig` | runtime | The app runtime, Retrieval-Interleaved Generation: abilities and their registry, the service contract, `Source` and admission through the reranker, the terminal tools (`citedReport`, `defineOutput`), configuration as data, the command loop, execution. Node-free at its root; `rig/node` holds the boots, models and slots, the config files, the media store and the served host; `rig/testing` runs a real harness over a scripted model with no weights. |
| `@lloyal-labs/media` | content plane | **Content-addressed media ingress.** An image or a PDF enters once, is normalised under a bounded gate, and is written by digest into an OCI Image Layout that `oras` can push to any registry; from then on the run carries descriptors, never bytes, so a media-bearing run replays from the exact pixels the model saw. [Below.](#the-content-plane) |
| `@lloyal-labs/binding` | surfaces | The harness's headless interface: an event bus down, commands up, and the projection a view folds over a bridge. Transports in `/node` (in-process, JSONL, the fork bridge) and `/web` (wss). Rack, for a program that runs rather than answers. |
| `@lloyal-labs/host` | serving | One resident model, N native harness sessions, FIFO admission: density through sharing, because the weights load once. Puma. |
| `@lloyal-labs/relay` | serving | The self-hostable relay: a headless harness served to remote frontends over wss, one process per connection. Unicorn. |
| `@lloyal-labs/desktop` | surfaces | The Electron main-process pieces: the engine over the project's own cli, the window, the content scheme that serves the store to the renderer, the preload bridge. |
| `@lloyal-labs/ui` | surfaces | The view side: `HarnessProvider` and its hooks over any bridge, the installer that shows a first run acquiring its models, the agent fold, prose and figure primitives that resolve a descriptor to what a reader sees. A view never holds truth and never calls the model. |
| `@lloyal-labs/dev-tools` | surfaces | The developer's pane: the timeline of every agent's lane on the one context, the sources funnel, the settings with their provenance, over the same events, present only under `LLOYAL_DEV=1`. |
| `@lloyal-labs/channel-verify` | channel | Canonical-JSON signing payloads and Ed25519 verification, zero dependencies, Apache 2.0: the public half of the channel, so anyone who wants to verify it may. |
| `@lloyal-labs/web-ability` | ability | Web search and page reading: keyed through Tavily, keyless with a paced fallback, every page admitted through the reranker under a token budget. |
| `@lloyal-labs/corpus-ability` | ability | A folder of markdown as a source: BM25 and the embedder find candidates, the reranker judges them, the index rebuilds under a live run when its path changes. |
| `@lloyal-labs/documents-ability` | ability | The documents attached to a conversation: text pages searched and read, and a page rendered and projected into the model when an agent must look at it. Declares `vision`. |
| `@lloyal-labs/wikipedia-ability` | ability | Search and fetch over Wikipedia's public REST, no key: the source the wiki template starts with. |

### The content plane

Attach an image or a PDF to a run and three things become true: the run **replays** from the exact bytes the
model originally saw, those bytes stay **inspectable** for as long as the project exists, and the store holding
them is a **valid OCI Image Layout** — `oras` pushes a run's media to any registry with none of this package's
code in the path. The artifact infrastructure you already operate can host your model's inputs.

```
attach                 ingress                              store                          the model                    the answer
image · PDF   ─▶  normalise, bounded:            ─▶  media/ — an OCI Image Layout   ─▶  a page is projected   ─▶  the same page comes back
                  4 concurrent, 16 queued            oci-layout · index.json               into the trunk ONCE,       out as a figure: the report
                  images to 4.2 MP                   blobs/sha256/<digest>                 through the vision          cites a descriptor, the view
                  PDFs to 32 MB, 120 s,              a manifest per attachment,            service, and every          resolves it through the
                  200 rendered · 400 text            a descriptor from then on             agent forked from it        content routes, the reader
                  pages, 16 figures                                                        shares it                   opens the exact page
```

Content addressing happens at the point of admission. A trace records a reference for every image, never the
pixels, so the store is part of the run's correctness, not an attachment feature. The layout is checked in CI
by driving `oras` against a layout this code wrote, and this reader against a layout `oras` wrote
(`npm run verify:oci`): the format claim holds independently of what the code believes about itself.

### Models as services

One contract for every model beside the trunk. A block under `model:` in `harness.yml` requests one; its
contents select the weights; an absent block is a decision. The install derives its steps from the blocks,
the machine gate refuses an undersized machine before a byte downloads, and harness or ability code reaches
a bound service with one call, `yield* service('reranker')`. Three rows ship today, in `rig`:

| service | what binds |
|---|---|
| `reranker` | A cross-encoder that scores what an agent fetched against the question it asked, relative within the query, so only the passages that answer it enter context. The [focal lens](https://docs.lloyal.ai/focal-lens). |
| `vision` | The projector paired with the trunk model, so a page or an image is projected into the model's context the moment an agent must look at it. |
| `embedding` | An embedder over its own context, serialized, with pooling declared per model: candidates found by distance for the reranker to judge. |

The same contract extends to audio encoders, speech sanitizers and specialist decision models: a row in one
table. [Services](https://docs.lloyal.ai/services) · [harness.yml](https://docs.lloyal.ai/harness-yml).

### Surfaces and serving

A harness runs as a terminal app, a desktop app or a served browser app off one program, because it exposes
its work through one interface: events down, commands up. Everything above that interface is convention, and
it is the shape Rails shipped in 2007: the binding is Rack, the host is Puma, the relay is Unicorn, the driver
that wires a harness to a host without either knowing the other is `config.ru`, and abilities are the gems —
ours arrive signed. [You already know this architecture.](https://lloyal.ai/blog/you-already-know-this-architecture/)

### The signed channel

Abilities never come from npm. `lloyal install` fetches the tarball from
[apps.lloyal.ai](https://apps.lloyal.ai), verifies its signature against the trust root shipped with the
framework, vendors the exact bytes into the project, and only then points `package.json` at them. Each ability
is a `Source`, its tools, the instructions to use them, its configuration and the services it needs, validated
by `defineAbility`; a saved setting applies to a running ability at its next take, under a live run, without a
restart. [Abilities](https://docs.lloyal.ai/abilities).

## Why in-process is a different capability

|                    | Endpoint SDK · Vercel AI / LangGraph / Ollama      | **HDK**                                                                   |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| The model is       | a service behind an HTTP boundary                  | resident in the process you run — laptop or your own GPU host             |
| Each sub-agent     | a fresh request that re-ships its context          | a zero-copy `fork()` of the parent's live attention                       |
| Ten agents cost    | 10× context · 10× dispatches · per-token billing   | one GPU dispatch per tick — cost tracks KV *fullness*, not agent count    |
| Prefix sharing     | a token-keyed KV cache, LRU-evicted, over an API   | a structural back-reference, pruned by *your* policy when the reasoning is done |
| API key            | required, billed per token                         | none on the reasoning path                                                |

Endpoint tools run agents like **VMs** — each a full context you stand up and re-feed. HDK runs them like
**containers on one kernel**: every agent is a branch of one resident model state.

The mechanism is verifiable, not marketing — **code-confirmed against the vendored llama.cpp build**, read
from source:

- **N branches, one dispatch.** N branches that fit the micro-batch decode in **one `llama_decode`** — the splitter cuts on token rows, never reads `seq_id`. GPU dispatches per tick are **O(1) in branch count**.
- **Forking is free.** A fork (`seq_cp`) allocates no cells and copies no buffer — a single `std::bitset<LLAMA_MAX_SEQ>` write, one cell now owned by two branches. Zero decode, zero attention. *This is* prefix sharing, by construction.
- **Cost is KV fullness, not agent count.** Per-tick wall-time is `O(n_kv × token_rows)` — no `× n_seqs` multiplier. **Two vs. ten concurrent agents decode at the same per-tick speed.**

And the model is a **dial** — the *same* harness runs across compute tiers, key-free at each:

| tier      | runs on                | model                                           | sessions                       |
| --------- | ---------------------- | ----------------------------------------------- | ------------------------------ |
| **Edge**  | a laptop               | a 4B, resident in-process                       | one, local                     |
| **Host**  | your own GPU box       | a frontier model (GLM-5.2), sharded across GPUs | many, over wss — FIFO-admitted |
| **Fleet** | a host per GPU cluster | frontier, per host                              | each host admits its own       |

vLLM and SGLang share prefixes too (RadixAttention) — but as a **server**, over an API, LRU-evicted. HDK puts
that tree *inside your app*, pruned by your policy, not a cache. A cloud per-token API can't replicate the
economics. [Continuous context](https://docs.lloyal.ai/continuous-context) ·
[agent policy and context pressure](https://docs.lloyal.ai/agent-policy-and-context-pressure).

## The programming model

The application contract is deliberately small — a harness is a scope that stays alive for a Session:

```typescript
export function* harness(
  ctx: SessionContext,               // the resident model + native session
  events: EventBus<WorkflowEvent>,   // application events → whichever surface is mounted
  commands: Signal<Command, void>,   // typed commands ← that surface
): Operation<void> {
  // Your intelligent application lives here.
}
```

Three trees describe one run, and they don't have to line up: the **lifetime tree** (Effection — what ends
together), the **inference-state tree** (`BranchStore` — what attention is inherited), and the
**orchestration graph** (your code — what depends on what). When the Session is released, the harness scope
ends and every child — pools, tool calls, temporary branches — unwinds with it. You never enumerate what to
cancel; the ownership tree already knows.

Four lines carry the model:

```typescript
const value = yield* operation;                       // perform owned work here, under this owner
const task = yield* spawn(operation);                 // concurrent work that cannot outlive this scope
const findings = yield* withSpine(options, body);     // borrow live attention, return durable data, reclaim the subtree
yield* call(() => session.commitTurn(query, answer)); // cross a Promise boundary; make the result durable, explicitly
```

The scaffolded templates are the worked examples, each with its own README and recipes:
[deep-research](https://github.com/lloyal-ai/lloyal-ai/blob/main/templates/research/README.md) and
[wiki](https://github.com/lloyal-ai/lloyal-ai/blob/main/templates/basic/README.md). Building without the
scaffold is [build your first harness](https://docs.lloyal.ai/build-your-first-harness).

## Repo layout

```
packages/
  sdk/             @lloyal-labs/sdk
  agents/          @lloyal-labs/lloyal-agents
  rig/             @lloyal-labs/rig
  media/           @lloyal-labs/media
  binding/         @lloyal-labs/binding
  host/            @lloyal-labs/host
  relay/           @lloyal-labs/relay
  desktop/         @lloyal-labs/desktop
  ui/              @lloyal-labs/ui
  dev-tools/       @lloyal-labs/dev-tools
  channel-verify/  @lloyal-labs/channel-verify
  abilities/
    web/           @lloyal-labs/web-ability
    corpus/        @lloyal-labs/corpus-ability
    documents/     @lloyal-labs/documents-ability
    wikipedia/     @lloyal-labs/wikipedia-ability
```

The native binding [`@lloyal-labs/lloyal.node`](https://github.com/lloyal-ai/lloyal.node) lives in its own
repository and is pulled in as a dependency. The CLI and the templates live in
[`lloyal-ai/lloyal-ai`](https://github.com/lloyal-ai/lloyal-ai).

## Requirements

- **Node 24+** — 24.15 or newer to run this repository's own test suite
- **A GGUF model file on disk** — any model the native backend supports (the scaffold fetches one, digest-verified, on first run)
- macOS / Linux / Windows on x64 or arm64. CPU works; CUDA / Metal / Vulkan supported via prebuilt native binaries.
- **Native backend:** [llama.cpp](https://github.com/ggml-org/llama.cpp) today, via `@lloyal-labs/lloyal.node`. The SDK and harness contracts sit above the engine — intelligence is written against the runtime, not the backend.

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
npm run build       # tsc -b across the workspace
npm run typecheck   # every package, and the root test config that covers the tests
npm test            # build, then the unit and invariant suites
```

Every PR runs build, typecheck, and unit tests on CI, plus a cross-repo GPU integration job: HDK PRs trigger
[`lloyal.node`](https://github.com/lloyal-ai/lloyal.node)'s GPU workflow, which builds the PR's packages
against the native runtime on NVIDIA L4 hardware and runs the full agent integration suite before merge.

## Docs

- **Build with Lloyal** → [hdk.lloyal.ai](https://hdk.lloyal.ai)
- **Learn, reference, guides** → [docs.lloyal.ai](https://docs.lloyal.ai) — start with [Thinking in lloyal](https://docs.lloyal.ai/thinking-in-lloyal)
- **API reference** — TypeDoc-generated from source

## Why FSL instead of MIT?

HDK apps are **capability-bearing** — arbitrary code (browser automation, file access, payment connectors)
bundled with skill instructions, running in shared inference context. OS sandboxing protects the machine; it
does nothing about what an app's content reaches the model's attention. Cloud agent platforms can yank
misbehaving extensions with a kill switch; HDK runs on user machines and can't.

Safety has to be **upstream and structural**: the canonical channel at [apps.lloyal.ai](https://apps.lloyal.ai)
reviews and Ed25519-signs every Ability; the runtime verifies that signature against an embedded trust root at
install. MIT doesn't preserve that — a fork could strip the trust root and ship to an unreviewed channel. FSL
restricts one thing — that fork — to keep the trust root enforceable. It can't stop a determined bad actor; it
keeps channel-switching from being the easy path.

## License

**Commercial use is unrestricted** — build and sell products with HDK, embed it in proprietary software, run
it in production. The FSL restriction is narrow: you cannot ship a competing HDK runtime, managed HDK service,
or alternative HDK Ability distribution channel.

The runtime packages — `@lloyal-labs/sdk`, `@lloyal-labs/lloyal-agents`, `@lloyal-labs/rig`,
`@lloyal-labs/media`, `@lloyal-labs/binding`, `@lloyal-labs/host`, `@lloyal-labs/relay`,
`@lloyal-labs/desktop`, `@lloyal-labs/ui`, `@lloyal-labs/dev-tools`, and the four first-party abilities — are
Fair Source under FSL-1.1-Apache-2.0 and convert to Apache 2.0 two years after each release.
`@lloyal-labs/channel-verify` is Apache 2.0 from day one — see its own `LICENSE` file; so is the CLI, which
lives in [`lloyal-ai/lloyal-ai`](https://github.com/lloyal-ai/lloyal-ai). `channel-verify` is Apache by design:
it is the public half of an asymmetric signing scheme, so anyone who wants to verify the channel must be free to.

See [`LICENSE-FAQ.md`](./LICENSE-FAQ.md) for concrete examples of what's permitted and what's restricted,
[`LICENSE`](./LICENSE) for the legal text, and [`NOTICE`](./NOTICE) for attribution.
