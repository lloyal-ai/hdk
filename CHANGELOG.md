# Changelog

Notable changes to the published packages. Anything that alters **behaviour of
existing code** is called out at the top of its release with a ⚠️, because a
version bump on a caret range reaches consumers without them asking for it.

Package versions are independent; each entry names what moved.

## Unreleased

`@lloyal-labs/sdk` 3.0.3 → **3.1.0** · `@lloyal-labs/rig` 5.0.1 → **5.1.0**

### ⚠️ Behaviour change — the reranker's KV cache defaults to f16

Was `q4_0`, hardcoded. Every reranker gains roughly **+322 MiB** at the default
`nCtx` of 4096, and produces **different scores** — so `search` and `fetch_page`
admit different chunks for the same query.

Quantised KV puts noise directly into a score that IS a logit difference. Six
leaves forked from one parent and given identical tokens must score identically;
the measured spread is the noise floor:

| KV type | KV @ nCtx 4096 | noise floor |
|---|---|---|
| `q4_0` (was the default) | 126 MiB | **1.270** logits |
| `q5_0` | 154 MiB | 0.813 — worse than `q4_0` serially; avoid |
| `q8_0` | 238 MiB | 0.122 |
| `f16` (now the default) | 448 MiB | **0.004** |

The `q4_0` floor **exceeded the boot gate's own `minGap` of 1.0**, so the
calibration gate was asserting a separation it could not resolve. It passed
anyway because the shipped fixtures separate by far more than either number,
which is also why it detects catastrophe and is blind to degradation.

f16 over `q8_0` because `q8_0`'s floor (0.122) is larger than the tightest
margin measured (0.061).

Not a defect in `BranchStore`, `Rerank`, `decode_scatter` or the logits read —
each was verified. Quantisation alone: identical logical state, different
physical blocks, different dequantisation.

**Retrieval ranking should improve, but that is unmeasured.** Top-K over
well-separated candidates tolerated the old floor, which is why nothing looked
wrong for five months.

**To keep the old footprint**, pass `typeK`/`typeV` explicitly — but a threshold
calibrated at f16 stops meaning anything below it:

```ts
createReranker(modelPath, { typeK: 'q8_0', typeV: 'q8_0' })
```

### Added

- **`RerankOpts.instruction`** (`sdk`) and **`RerankerLoadOpts.instruction`**
  (`rig`) — the `<Instruct>` line is a parameter. It was a module constant, so
  the reranker could be asked exactly one question: retrieval relevance.
  Defaults to `RETRIEVAL_INSTRUCTION`, which renders **byte-identically** to the
  previous hardcoded prefix, so existing callers are unchanged.

  The fixtures ship with the sentence — `RerankInstruction` requires a
  `smokeTest` alongside `text`, because a fixture validates a *question*, not a
  model. Reuse retrieval's Paris/photosynthesis pair under a support instruction
  and the boot gate passes having tested nothing. Pass `smokeTest: 'none'` to
  boot unchecked, which is for calibration harnesses measuring a question they
  expect to fail.

- **`typeK` / `typeV`** on `RerankerLoadOpts` — the KV cache type is now
  tunable, defaulting to f16 as above.

- **`npm run eval:reranker`** — three evals under
  `packages/rig/test/evals/reranker/`, split by what they answer: an invariant
  that fails (leaf isolation), a calibration that reports numbers (instruction
  discrimination), and a resource measurement (KV footprint). They need a real
  model and take minutes, so they are `.eval.ts` and never run in `test:unit` —
  but they *are* typechecked, via `npm run typecheck:evals`.

### Fixed

- `createReranker` leaked its `SessionContext` when `Rerank.create` threw. A
  failing smoke test is a normal configuration outcome now the instruction is a
  parameter, and the throw escapes before `provide`, so the resource's `finally`
  never ran — 448 MiB per failed boot.

- `models/` is gitignored. `resolveModel` materialises verified models into
  `<projectRoot>/models/` (~624 MiB) and nothing was ignoring it at the repo
  root.

### Known limits

- **The reranker is a relative ranker, not an absolute one.** Within a passage
  it orders correctly; across passages the scale shifts (measured global overlap
  1.581). Score it as top-K within a query — as `FetchPageTool` already does —
  never as a global threshold. `SearchTool`'s floor is a discrimination signal,
  not a relevance line.

- **Compound instructions invert.** "date AND actor AND modality" ranks
  wrong-actor above a verbatim restatement. A cross-encoder follows one
  criterion, not a conjunction of three.

- Support judgement is expressible and **not validated**. The best wording
  measured 0.135 on the hard question — 34× the f16 noise floor, but thin, on
  one fixture set.

## v5.1.0 — 2026-08-17

`@lloyal-labs/lloyal-agents` 5.0.0 → 5.1.0

- **`AgentResult.exitReason`** — a result now says why its agent stopped:
  `pressure_critical` · `policy_exit` · `pressure_softcut` · `maxTurns`, and
  `undefined` for a normal completion. A result produced under
  `pressure_critical` is a forced recovery report written to a capped budget,
  not a considered one, and callers that care should say so. (#98)
- Re-froze the channel golden fixture on the re-signed catalog. (#97)

---

Earlier releases predate this file. `git for-each-ref --sort=-creatordate
refs/tags` lists the tags; note the scheme is per-package
(`v3.9.0-rig`, `v0.10.0-cli`) alongside repo-level (`v5.1.0`).
