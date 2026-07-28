# harness.dev

**`rails new` for agentic AI apps — the model lives inside, no API key.**

`harness.dev` is the CLI for the [lloyal HDK](https://github.com/lloyal-ai/hdk). It scaffolds a **harness** — a runnable vertical-inference application in ordinary TypeScript — and runs it on a **resident** model: execution needs no network and no inference-provider service. Every agent scaffold starts with `API_KEY=`. A harness starts with a model.

```bash
npx harness.dev new              # interactive: name → surfaces → model → template
cd my-harness && npm install && npm start
```

```text
first run:
  scaffolded acme (blank) · targets: cli, desktop, web · model: qwen3.5-4b
  ...
  Model      qwen3.5-4b                   ● resident
  Inference  local · no provider endpoint   ● offline
  ready — type to begin, ctrl-c to stop
```

The recommended model is downloaded + digest-verified into `models/llm/` on first run (no key).

## One harness, many surfaces

A harness is **one program**. `harness.yml` declares the surfaces it runs on and the model it thinks with — the one place "many surfaces" is spelled out:

```yaml
# harness.yml
targets: [cli, desktop, web]                    # the surfaces this harness runs on
model:
  llm: { id: "qwen3.5-4b", context: 32768 }   # the resident model it thinks with
```

You write the program once, under `harness/`; the CLI generates a binding per surface under `targets/`:

```text
my-harness/
├── harness.yml          targets + model
├── harness/             YOUR program
│   ├── harness.ts         the controller — agents, tools, when work is done
│   ├── protocol.ts        the commands (↑) and events (↓) it speaks
│   └── state.ts           reduce(state, event) — the state every surface folds
├── models/              resident, digest-verified weights (gitignored)
└── targets/             generated bindings — cli · desktop · web
```

The line that makes it click: `harness.dev targets:add web` adds a browser surface **without touching `harness.ts`**. Same program, one more transport. It's MVC with a live model as the Model — `harness.ts` is the Controller, your surfaces are the Views, the resident model holds the live generative state. The same contract is what lets that program scale from your laptop to a served GPU fleet: *where* it runs is a deployment decision, not an application one. [You already know this architecture — it shipped in Rails in 2007.](https://lloyal.ai/blog/you-already-know-this-architecture/)

## Commands

Grammar: one bare verb for the primary artifact (`new`); `<noun>:<verb>` namespaces to manage a project (`models:`, `targets:`, `app:new`). The signed-channel commands (`install` / `publish` / `publishers` / `review`) use subcommands.

**Scaffold**

```bash
npx harness.dev new [name]                       # scaffold a harness (interactive if no name)
npx harness.dev new my-app --template research   # a production research harness: recon, planning,
                                                 #   parallel investigation, evidence admission, synthesis
npx harness.dev app:new <name>                   # scaffold an App (a portable capability package)
```

`new` flags (any also pre-seed the picker): `--targets cli,desktop,web` · `--model <id|path>` · `--template <blank|research>` · `--yes` (CI) · `--dir <path>`.

**Manage a scaffolded project** (run from its root)

```bash
npx harness.dev models:use <id>                  # pin a catalog model (downloaded + verified next run)
npx harness.dev models:add <path>                # register a local .gguf you already have
npx harness.dev models:download <url> [--sha256 <hex>]  # stream a .gguf into models/<role>/
npx harness.dev models:list                      # catalog ids · active pins · installed files

npx harness.dev targets:add <desktop|web>        # bind the same harness to another surface
npx harness.dev targets:remove <desktop|web>     # drop a surface
npx harness.dev targets:list                     # show the surfaces present
```

The `models:` verbs own the write to `harness.yml`'s `model.<role>.{id|path}`, so the manifest is never hand-edited. A catalog `id` is downloaded + digest-verified fail-closed; a `path` is a local weight you point at, trusted explicitly.

**Apps + the signed channel**

An **AgentApp** — an **App** in commands and code — is a portable capability package: a protocol, tools, skills, config and grants a harness can enable.

```bash
npx harness.dev install <publisher>/<name>       # install a signed App from apps.lloyal.ai
```

Every install is verified before it runs:

- Ed25519-signed catalog and bundle
- integrity-audited lockfile
- install scripts disabled by default
- the app's *attention surface* — protocol · tools (some `[needs grant]`) · config keys · skill lines — shown from the verified bytes first

**What you install is what was reviewed.**

**Publishers**

```bash
npx harness.dev publishers register              # claim your publisher handle
npx harness.dev publish                          # build, sign, and submit your App
npx harness.dev publish status <id>              # check a submission
npx harness.dev review                           # (reviewers) inspect + approve submissions
```

## Where it sits

Most "AI for TypeScript" tools are a **client to an inference endpoint**: the Vercel AI SDK calls a provider's API; LangGraph orchestrates a graph of calls over one — even "local," through Ollama, the model runs as a separate daemon you POST to. The model is a service behind a boundary, so every agent, every turn, re-ships its context and pays per token.

Lloyal isn't a client — it's a **runtime that embeds the model**, the way an app embeds SQLite instead of reaching a database over the network. The weights are resident in your process, and your harness — ordinary TypeScript — governs the model's *live* reasoning state as it runs. That's the difference between renting behaviour request-by-request and owning it as code.

It's also why concurrent agents are cheap. Endpoint tools coordinate agents like **VMs** — each is a full, isolated context you stand up and re-feed. Lloyal runs them like **containers on one kernel**: every agent is a zero-copy *branch* of one resident model state, forked for free and decoded in the same pass. Cost tracks how much context is live, not how many agents run.

If you know the serving stack: vLLM and SGLang already reuse prefixes (RadixAttention) and fork parallel decodes — but as a **server**, where the shared prefix is a token-keyed KV *cache* (radix-matched, LRU-evicted; a miss recomputes) reached over an API. Lloyal puts that tree *inside your application*. A branch is a `fork()` — a structural **back-reference** into its parent's live cells, shared by construction (nothing to match, cache, or evict) — and it's pruned **semantically and topologically**: your harness retires a branch when the *reasoning* is done or a subtree is a dead-end, governed by policy, not evicted when a cache runs cold. The KV math is the same; the tree is yours, in-process, and institutional — not a throughput optimization you rent from a server.

- **No key on the inference path.** Model execution never depends on a third-party API — `grep API_KEY` in a scaffolded project finds nothing. Apps use the network only when a capability calls for it (a search token, an OAuth grant); that never touches the reasoning path.
- **Continuous context.** Agents are zero-copy KV branches over one live model state — fan-out, chains and DAGs without serialising or summarising context between them.
- **Apps arrive signed.** First- and third-party ride the same Ed25519-verified path from a curated, reviewed catalog.

**[Docs →](https://docs.lloyal.ai/cli)** · **[Build an App →](https://docs.lloyal.ai/build-an-app/what-is-an-app)** · **[The HDK →](https://github.com/lloyal-ai/hdk)**

## License

Apache-2.0 — the CLI is fully open. (The HDK runtime packages are FSL-1.1-Apache-2.0; see each package's LICENSE.)
