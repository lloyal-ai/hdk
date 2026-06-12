# @lloyal-labs/rig

**The App runtime for the [lloyal HDK](https://github.com/lloyal-ai/hdk).**

An App packages a knowledge source, its tools, and a skill prompt into a signed, installable capability. `rig` is everything between a signed bundle and tools live in an agent's context: load, verify, register, configure, authorize, and compose Apps into the shared prompt spine — plus the framework toolset (`report`, `delegate`, `plan`) and the shared reranker every App scores against.

```bash
npm i @lloyal-labs/rig @lloyal-labs/lloyal-agents @lloyal-labs/lloyal.node
```

```typescript
import { createAppRegistry, loadBundle, renderSpine } from "@lloyal-labs/rig";

const registry = yield* createAppRegistry();
const factory = yield* loadBundle("lloyal/corpus");   // fetch + Ed25519-verify from the channel
const app = yield* registry.enable(factory);
const spinePrompt = renderSpine({ apps: registry.enabled() });
```

**[Docs →](https://docs.lloyal.ai)** · **[Build an App →](https://docs.lloyal.ai/build-an-app/what-is-an-app)** · **[harness.dev CLI →](https://www.npmjs.com/package/harness.dev)**

## Why retrieval lives inside generation

RAG retrieves first, then generates. A retrieval step runs upfront — query the vector DB, get top-k passages, inject them into the prompt, call the model once. The model sees static context. Retrieval and generation are separate phases.

RIG interleaves retrieval and generation **inside the decode loop**. Agents generate reasoning, decide to search, process results, reason further, fetch a page, form hypotheses from the content, search again with refined queries. Retrieval decisions emerge from ongoing generation — each search query is informed by everything the agent has already discovered.

The difference is observable in tool call inputs. A RAG system constructs search queries from the original user question. A RIG agent constructs queries from hypotheses formed during generation:

```
grep(/memory leak/)            → 3 matches in 2 files
read_file(pool.ts L40-80)      → reads allocation logic, spots missing cleanup
search("resource cleanup on connection close")  → finds teardown handler
read_file(server.ts L120-155)  → discovers close handler never calls pool.drain()
grep(/drain|dispose|cleanup/)  → 8 matches, confirms drain exists but is unused
search("pool drain connection lifecycle interaction")  → targets the gap
report(findings)
```

The last search — `"pool drain connection lifecycle interaction"` — is the signature behavior. The agent read the allocation logic, discovered the drain method existed but was never called on connection close, and constructed a search specifically targeting that interaction. This is multi-hop reasoning: not "search and report" but "search, form hypothesis, search for confirmation."

### Why it's emergent

This behavior is not prompted or engineered. It emerges from the concurrency semantics of `lloyal-agents`.

The five-phase tick loop creates a clean decision boundary between each tool call and the next generation step:

1. Agent generates tokens, hits stop token, tool call extracted
2. Tool executes to completion — agent is suspended
3. Tool result fully prefilled into the agent's KV cache
4. Grammar state resets — clean slate for next decision
5. Agent resumes generating with the complete result as the last thing in context

Step 5 is the critical moment. The model's next-token prediction operates on a context where the tool result is fully present and the grammar is clean. The model makes a fresh decision: call another tool, call the same tool with different arguments, or report findings. This decision is informed by everything the agent has seen — all prior tool results are physically present in the branch's KV cache.

An agent that greps with a narrow pattern and gets 0 matches will broaden the pattern on its next grep — not because it's prompted to retry, but because the 0-match result is in context and the model naturally adjusts. An agent that reads a section and discovers an unexpected connection will construct a search query targeting that specific connection — the read result is in context, and the model forms a hypothesis from it.

Depth scales with `maxTurns`. At 2 turns, agents do single-shot retrieval. At 6 turns, agents do 3–4 rounds of iterative refinement. At 20 turns, agents go deep — following citation chains, cross-referencing claims, building evidence maps. The quality difference is in the later tool call inputs.

## Sources via the HDK 3.0 App protocol

`@lloyal-labs/rig` is the framework layer; concrete `Source` implementations
ship as separate **apps** under the HDK 3.0 App protocol (RFC §5):

**`@lloyal-labs/corpus-app`** — local files with grep, semantic search,
read_file, and recursive delegation. Agents investigate a knowledge base by
pattern matching, reading sections in context, and spawning sub-agents for
deeper investigation.

**`@lloyal-labs/web-app`** — web search via [Tavily](https://tavily.com) (or
keyless DuckDuckGo fallback), page fetching with attention-based content
extraction, and recursive delegation. `BufferingFetchPage` wraps fetch
results — full content goes to the agent for reasoning, while a parallel
buffer stores content for post-research reranking. Content extraction uses
an ephemeral fork to attend over the fetched page and extract summary +
links via grammar-constrained generation, then prunes the fork — zero net
KV cost per extraction.

Apps are composable through the registry:

```typescript
import {
  createAppRegistry,
  createInMemoryConfigStore,
} from "@lloyal-labs/rig";
import { RerankerCtx } from "@lloyal-labs/lloyal-agents";
import { createWebApp } from "@lloyal-labs/web-app";
import { createCorpusApp } from "@lloyal-labs/corpus-app";

yield* RerankerCtx.set(reranker);
const configStore = createInMemoryConfigStore();
if (tavilyKey) yield* configStore.set("web", { tavilyKey });
if (corpusDir) yield* configStore.set("corpus", { corpusPath: corpusDir });
const registry = yield* createAppRegistry({ configStore });

if (corpusDir) yield* registry.enable(createCorpusApp);
yield* registry.enable(createWebApp);  // keyless fallback if no tavilyKey
```

When multiple apps are enabled, their sources run sequentially — each gets
the full KV budget. After source N completes, its inner branches are pruned
and KV is freed for source N+1.

### Cross-encoder reranker — four scoring roles

The reranker (a small cross-encoder GGUF — Qwen3-Reranker-0.6B is the recommended default) drives an `EntailmentScorer` with four distinct methods:

- **`scoreEntailmentBatch`** — texts vs. the original query. Boundary entailment for retrieved content.
- **`scoreRelevanceBatch`** — dual-score `min(toolQueryScore, originalQueryScore)`. Used in exploit mode when KV pressure tightens focus.
- **`scoreSimilarityBatch`** — texts vs. an arbitrary reference. Powers echo detection at delegation boundaries (the agent's own task as reference).
- **`shouldProceed`** — floor gate. Default `_entailmentFloor = 0` (logit-diff space: `≥ 0` ⇒ model prefers "yes" over "no"; subclasses may tighten or loosen).

One model, four roles. The reranker is RIG infrastructure, not a fetch optimization.

### Bridge

Between sources, a bridge structures discoveries from the completed source as durable context for the next source's investigation:

```
Corpus research → Bridge → Web research → Synthesize
```

The bridge extracts three tiers of discovery:

1. **What was established** — specific data points, study details, statistics, quotes. Evidence preserved verbatim.
2. **Where evidence is incomplete** — acknowledged limitations, absent study designs, uncertain mechanisms. Well-researched claims with identified evidence gaps.
3. **What was not covered** — topics mentioned but not substantiated, or entirely absent.

The distinction between (2) and (3) is critical. A topic with six sections of evidence but no experimental validation is not a gap — it is a well-researched claim with an identified evidence limitation. The bridge flags the limitation, not the topic. This prevents the next source from re-investigating what the previous source already covered, and directs it toward genuine gaps.

## Pipeline

A typical RIG pipeline:

```
Plan → Research → [Bridge →] Synthesize → Eval
```

**Plan.** Grammar-constrained decomposition of the user query into sub-questions with intent classification (`research` vs `clarify`). If the query is focused enough to investigate directly, produces an empty array (passthrough). `PlanTool` uses `agent()` with a JSON schema grammar — the model outputs structured `{ questions: [{ text, intent }] }` in a single generation pass.

**Research.** Each source's tools are passed to an `agentPool` that investigates sub-questions in parallel (or in chain mode, sequentially with spine extension). Agents interleave retrieval and generation — searching, reading, forming hypotheses, searching again. Within each source, all agents run concurrently on shared GPU compute. Sources run sequentially, each getting the full KV budget.

Agents that get cut by context pressure (their tool results exceeded KV headroom) are recovered via scratchpad extraction — a grammar-constrained reporter prompt attends over the agent's accumulated KV and extracts findings. The agent paid the KV cost of reasoning; the extraction recovers the value.

**Bridge.** Runs between sources when multiple sources are configured. A single agent with report-only tools structures discoveries from the completed source. The bridge output conditions the next source's sub-questions, directing investigation toward gaps rather than re-covering established ground.

**Synthesize.** A synthesis agent integrates findings from all sources into a structured report with source attribution. Research notes provide analytical structure; reranked source passages provide ground truth for citation. The synthesizer cross-references both — using research notes to identify what matters, and source passages for evidence.

**Eval.** Multi-branch semantic comparison via `diverge()`. Fork N branches from a shared frontier, generate independently with the same verify prompt, check convergence. Where branches agree, the model is confident. Where they diverge, the answer needs refinement.

Full architectural walkthrough: [RIG Pipeline reference](https://docs.lloyal.ai/reference/rig/pipeline).

## Framework tools

| Tool           | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `ReportTool`   | Terminal tool — agents call this to submit findings                          |
| `PlanTool`     | Grammar-constrained query decomposition with intent classification           |
| `DelegateTool` | Generic recursive-delegation tool — agent calls it to spawn a sub-agent pool |

App-scoped tools (`web_search`, `fetch_page`, `search`, `read_file`,
`grep`) live in their owning app — `@lloyal-labs/web-app`,
`@lloyal-labs/corpus-app`, and so on — installed via
`harness.dev install lloyal/<name>`. Build your own app with
`harness.dev app <name>`.

## Search providers

The `lloyal/web` app ships with two interchangeable `SearchProvider`
implementations exposed from rig so apps can swap providers without
vendoring an API client:

| Provider                           | Description                                                       |
| ---------------------------------- | ----------------------------------------------------------------- |
| `TavilyProvider`                   | Tavily-backed web search (key from constructor or env)            |
| `createKeylessSearchProvider()`    | Keyless DuckDuckGo fallback with built-in pacer + circuit breaker |

## Node-only surface (`@lloyal-labs/rig/node`)

| Symbol                 | Description                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| `createReranker(path)` | Semantic reranker — runs the cross-encoder GGUF against text batches       |
| `loadResources(dir)`   | Walk a directory into `Resource[]` for corpus apps                         |
| `chunkResources(rs)`   | Split resources into `Chunk[]` for tokenization + reranker scoring         |

### `DelegateTool`

`DelegateTool` is the canonical recursive-delegation primitive. It takes a tool name, a sub-task extractor, a system prompt, and pool options — when the agent calls it, the tool spawns an inner `agentPool` with `parent: context.branch` (warm path) so sub-agents inherit the calling agent's full KV state at zero marginal cost.

```typescript
import { DelegateTool, reportTool } from "@lloyal-labs/rig";

const delegate = new DelegateTool({
  name: "web_research",
  extractTasks: (a) => a.questions as string[],
  systemPrompt: RESEARCH_PROMPT,
  poolOpts: {
    tools: [...sourceTools, reportTool],
    terminal: reportTool,
    scorer,
  },
});
```

The agent sees `web_research` (or whatever `name` you give it) as a callable tool. Calling it spawns parallel sub-agents that recurse into the corpus or web. The deeper an investigation goes, the richer the attention state at depth — and the cost of inheritance is zero.

## Building your own App

Apps are the HDK 3.0 unit of distribution. An App bundles a
`Source` + `Tool[]` + `skill.eta` + `app.json` manifest and gets
shipped to consumers via the signed channel at `apps.lloyal.ai`.

Scaffold one with:

```bash
npx harness.dev app my-app
```

The scaffold ships with a working source + two tools calling
Wikipedia's REST API as a runnable demo backend. Replace the tool
bodies with your real backend, keep the schemas, and you're a
`harness.dev publish` away from being installable in any HDK
harness.

See [docs.lloyal.ai/build-an-app](https://docs.lloyal.ai/build-an-app)
for the full App protocol contract.

## Documentation

Full positioning, App protocol, reranker mechanics, and pipeline
patterns at [docs.lloyal.ai](https://docs.lloyal.ai).

## License

See [LICENSE](./LICENSE) (Functional Source License 1.1 — Apache 2.0 Future License).
