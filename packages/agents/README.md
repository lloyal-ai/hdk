# @lloyal-labs/lloyal-agents

**Run a team of agents on hardware that serves one.**

`lloyal-agents` schedules memory, not strings. An agent is a branch of the model's live attention state: shared context is **inherited, not re-sent** — a new agent attends over everything before its fork point without paying a token for it. Advancing the whole fleet costs one GPU forward pass per tick. The more your agents share, the cheaper they get — the inverse of the API-call model, where every agent re-reads the world on every step.

## Start here

Most people should not install this package by hand. The [`lloyal-ai`](https://www.npmjs.com/package/lloyal-ai) CLI scaffolds a **harness** — a runnable app in ordinary TypeScript, over a model you own, resident in your process or served from your own GPU host — with this package already wired in:

```bash
npx lloyal-ai new
cd my-harness && npm install && npm start
```

[Build your first harness](https://docs.lloyal.ai/build-your-first-harness) walks that path end to end. Come back here when you want to know what the harness is standing on.

```bash
npm i @lloyal-labs/lloyal-agents @lloyal-labs/lloyal.node
```

## What becomes possible

```typescript
yield* withSpine({ systemPrompt: PLAYBOOKS, tools }, function* (spine) {
  // spine is a prefilled branch — system prompt + tool schemas already in KV.
  // Every agent forked from it shares that prefix physically.
  return yield* agentPool({
    orchestrate: parallel(
      questions.map((q) => ({ content: q, systemPrompt: WORKER_PROMPT })),
    ),
    tools: [...sourceTools, reportTool],
    parent: spine,
    terminal: reportTool,
  });
});
```

Three properties of agents that share one live context, none of which holds across separate model calls:

- **Live-state forks.** A child is forked from its parent's branch at the exact token where it diverges, inheriting KV and sampler state mid-generation. Nothing is re-sent and nothing has to match a cached block: what the parent attended over, the child has already attended over.
- **True concurrency on one GPU.** Continuous tree batching packs every agent's next token into a single `llama_batch` — eight agents stream in lockstep on hardware that serves one.
- **Structured concurrency over KV tenancy.** A branch holds a lease on the shared context, and the lease lives and dies with the scope that owns it: spawn a sub-agent from a live thought mid-reasoning, halt a subtree and its KV is reclaimed, leave the scope and teardown is guaranteed. An agent cut under context pressure hands back its findings from the attention state it leaves behind.

## Reading the code

The pool is one loop: observe, schedule, apply, execute, apply. Each tick reads its state once, makes one pure decision — a `Schedule`, a description of work — and then enacts it. [`docs/scheduler.md`](./docs/scheduler.md) is the one page to read before the source: the five phases and the file that runs each, the `Schedule` fields in the code's own words, the exact agent states, recovery and the failure ladder, and nine invariants each tied to the test that holds it.

## Concepts, where they are explained

- **The model behind all of it** — owned lifetimes over live inference state: [Thinking in Lloyal](https://docs.lloyal.ai/thinking-in-lloyal).
- **Shared frontier and the spine** — why a fork costs nothing and what a branch inherits: [Continuous Context](https://docs.lloyal.ai/continuous-context).
- **Policy and context pressure** — how agents are nudged, cut and recovered as KV fills: [Adaptive compute through semantic pruning](https://docs.lloyal.ai/agent-policy-and-context-pressure).
- **Tools and Abilities** — one `Tool[]` given to the spine and to the pool; abilities package tools with their prompts and grants: [Abilities](https://docs.lloyal.ai/abilities).
- **Orchestrators** — `parallel`, `chain`, `fanout`, `dag`, `reduce`, or your own generator over the pool context: the [API reference](https://hdk.lloyal.ai/reference).
- **Events** — every state change is projected to the trace and to consumer events; the vocabulary is `src/trace-types.ts`.

## Surface at a glance

```typescript
import {
  initAgents,        // bootstrap: session, store, event channel
  useAgent, agent,   // single-agent helpers
  agentPool,         // multi-agent pool with a swappable orchestrator
  useAgentPool,      // the underlying Effection resource
  parallel, chain, fanout, dag, reduce,  // orchestrators / combinators
  withSpine,         // scoped spine branch with guaranteed teardown
  Tool, Source,
  DefaultAgentPolicy,
  Ctx, Store, Events,
  // Ability protocol primitives — contexts the registry and the pool pick up.
  // Construction lives in `@lloyal-labs/rig` (`defineAbility`, `createAbilityRegistry`).
  AbilityRegistryCtx, AbilityConfigStoreCtx, GrantStoreCtx, RerankerCtx,
} from "@lloyal-labs/lloyal-agents";

import type {
  Ability, AbilityManifest, AbilityProtocol, AbilityFactory, AbilityState,
  AgentRenderCtx, SkillTemplateFn,
  AbilityConfigStore, GrantStore,
} from "@lloyal-labs/lloyal-agents";
```

Full reference at [hdk.lloyal.ai/reference](https://hdk.lloyal.ai/reference); positioning, guides and mechanics at [docs.lloyal.ai](https://docs.lloyal.ai).

## License

See [LICENSE](./LICENSE) (Functional Source License 1.1 — Apache 2.0 Future License) and the [licensing FAQ](./LICENSE-FAQ.md).
