# harness.dev

**`rails new` for agentic AI apps — the model lives inside, no API key.**

`harness.dev` is the CLI for the [lloyal HDK](https://github.com/lloyal-ai/hdk). It scaffolds a **harness** — a runnable vertical-inference application in ordinary TypeScript — and runs it on a **resident** model: the weights live in your project, and nothing on the inference path touches the network. Every scaffold in this category opens with *add your API key to `.env`*; this one has no such line.

```bash
npx harness.dev new              # interactive: name → surfaces → model → template
cd my-harness && npm install && npm start
```

`new` fetches + digest-verifies the recommended model into `models/llm/` on first run (no key), then `npm start` opens a terminal UI. One harness, several surfaces — **cli** (terminal), **desktop** (Electron), **web** (browser over a local host) — all folding one `reduce`.

## Commands

The grammar: one bare verb for the primary artifact (`new` scaffolds a harness); `<noun>:<verb>` namespaces manage everything else.

**Scaffold**

```bash
npx harness.dev new [name]                       # scaffold a harness (interactive if no name)
npx harness.dev new my-app --template research   # start from the tuned recon → plan → agents → synth pipeline
npx harness.dev app:new <name>                   # scaffold an App (a Source + Tools + skill bundle)
```

`new` flags (any also pre-seed the picker): `--targets cli,desktop,web` · `--model <id|path>` · `--template <blank|research>` · `--yes` (CI) · `--dir <path>`.

**Manage a scaffolded project** (run from its root)

```bash
npx harness.dev models:use <id>                  # pin a catalog model (fetched + verified next run)
npx harness.dev models:add <path>                # register a local .gguf you already have (BYO)
npx harness.dev models:download <url> [--sha256 <hex>]  # stream a .gguf into models/<role>/
npx harness.dev models:list                      # catalog ids · active pins · installed files

npx harness.dev targets:add <desktop|web>        # add a run surface (the inverse of prune)
npx harness.dev targets:remove <desktop|web>     # drop a surface
npx harness.dev targets:list                     # show the surfaces present
```

The `models:` verbs own the write to `harness.yml`'s `model.<role>.{id|path}`, so the manifest is never hand-edited. A catalog `id` is fetched + digest-verified fail-closed; a `path` is a BYO weight trusted by possession.

**Apps + the signed channel**

```bash
npx harness.dev install <publisher>/<name>       # install a signed AgentApp from apps.lloyal.ai
```

Every install is verified end-to-end: Ed25519-signed catalog and bundles, integrity-audited lockfile, install scripts disabled by default, and the app's *attention surface* (its tools, skill lines, and config keys) printed from the verified bytes before it lands. What you install is what was reviewed.

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

- **No key on the inference path.** Model execution never depends on a third-party API — `grep API_KEY` in a scaffolded project finds nothing. Apps may declare *capability* credentials (a search token, an OAuth grant); those never touch the reasoning path.
- **One harness, many surfaces.** cli · desktop · web are bindings over one node-free `reduce`; the center you write (`harness/harness.ts`) never changes when you add a surface.
- **Apps arrive signed.** First- and third-party ride the same Ed25519-verified path from a curated, reviewed catalog.

**[Docs →](https://docs.lloyal.ai/cli)** · **[Build an App →](https://docs.lloyal.ai/build-an-app/what-is-an-app)** · **[The HDK →](https://github.com/lloyal-ai/hdk)**

## License

Apache-2.0 — the CLI is fully open. (The HDK runtime packages are FSL-1.1-Apache-2.0; see each package's LICENSE.)
