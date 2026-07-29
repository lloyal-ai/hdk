# harness.dev

**`rails new` for agentic AI apps — the model lives inside, no API key.**

`harness.dev` is the CLI for the [lloyal HDK](https://github.com/lloyal-ai/hdk). It scaffolds a **harness** — a runnable vertical-inference app in ordinary TypeScript — and runs it on a model **you own**: resident in your process on a laptop, or served from your own GPU host. Every agent scaffold starts with `API_KEY=`; a harness starts with a model.

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

The recommended model is downloaded + digest-verified into `models/llm/` on first run.

## One harness, many surfaces

A harness is **one program** that ships as many apps. `harness.yml` lists its **targets** — each scaffolded into a full-stack app (a frontend *and* the deploy that runs it) — and the model it thinks with:

```yaml
# harness.yml
targets: [cli, desktop, web]                    # each scaffolds a full-stack app
model:
  llm: { id: "qwen3.5-4b", context: 32768 }   # the resident model it thinks with
```

| target    | you get                    | run                                 |
| --------- | -------------------------- | ----------------------------------- |
| `cli`     | a terminal app             | `npm start`                         |
| `desktop` | a native Mac / Windows app | `npm run dev:desktop`               |
| `web`     | a browser app (served)     | `npm run serve` → `npm run dev:web` |

You write the program once, under `harness/`; the CLI generates the full stack per target under `targets/` — each a thin wiring layer over your shared `harness.ts`:

```text
my-harness/
├── harness.yml          targets + model
├── harness/             YOUR program
│   ├── harness.ts         the controller — agents, tools, when work is done
│   ├── protocol.ts        the commands (↑) and events (↓) it speaks
│   └── state.ts           reduce(state, event) — the state every surface folds
├── models/              resident, digest-verified weights (gitignored)
└── targets/             one full-stack app per target — cli · desktop · web
```

`harness.dev targets:add web` adds a browser app **without touching `harness.ts`** — it's MVC with a live model as the Model: your harness is the Controller, surfaces are Views. [You already know this architecture — it shipped in Rails in 2007.](https://lloyal.ai/blog/you-already-know-this-architecture/)

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

> **Most "AI for TypeScript" is a *client to an inference endpoint*. Lloyal *embeds the model* — the way your app embeds SQLite, not a database server.**

|                    | Endpoint SDK · Vercel AI / LangGraph / Ollama      | **Lloyal HDK**                                                            |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| The model is       | a service behind an HTTP boundary                  | resident in the process you run — laptop or your own GPU host             |
| Each sub-agent     | a fresh request that re-ships its context          | a zero-copy `fork()` of the parent's live attention                       |
| Ten agents cost    | 10× context · 10× dispatches · per-token billing   | one GPU dispatch per tick — cost tracks KV *fullness*, not agent count    |
| Prefix sharing     | a token-keyed KV cache, LRU-evicted, over an API   | a structural back-reference, pruned by *your* policy when the reasoning is done |
| API key            | required, billed per token                         | none on the reasoning path                                                |

Endpoint tools run agents like **VMs** — each a full context you stand up and re-feed. Lloyal runs them like **containers on one kernel**: every agent is a branch of one resident model state, forked for free and decoded in the same pass.

And the model is a **dial** — the *same* harness runs across compute tiers, key-free at each:

| tier      | runs on                       | model                                           | sessions                       |
| --------- | ----------------------------- | ----------------------------------------------- | ------------------------------ |
| **Edge**  | a laptop / the user's machine | a 4B, resident in-process                       | one, local                     |
| **Host**  | your own GPU box              | a frontier model (GLM-5.2), sharded across GPUs | many, over wss — FIFO-admitted |
| **Fleet** | a host per GPU cluster        | frontier, per host                              | each host admits its own       |

- **Apps reach the network only for their own capabilities** — a search token, an OAuth grant — never the reasoning path itself.
- **Apps arrive signed.** First- and third-party ride the same Ed25519-verified path from a curated, reviewed catalog — an App's *attention surface* (protocol · tools · config · skills) shown from the verified bytes before install.

**[Docs →](https://docs.lloyal.ai/cli)** · **[Build an App →](https://docs.lloyal.ai/build-an-app/what-is-an-app)** · **[The HDK →](https://github.com/lloyal-ai/hdk)**

## License

Apache-2.0 — the CLI is fully open. (The HDK runtime packages are FSL-1.1-Apache-2.0; see each package's LICENSE.)
