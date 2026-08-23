# Reranker evals

Not unit tests. These load the real ~640 MB reranker and take minutes, so they
are `.eval.ts` — vitest's include is `packages/*/test/**/*.test.ts` and must
never pick them up. Run them deliberately:

```sh
npm run eval:reranker                    # all three
npx tsx packages/rig/test/evals/reranker/isolation.eval.ts q4_0 q8_0 f16
```

They ARE typechecked, via the `tsconfig.json` one level up, and that is
deliberate. An earlier version of these lived in `scripts/`, which nothing
typechecked; a `task` option the target branch did not have was silently
dropped by `tsx`, and a full run produced numbers for the wrong instruction.
The tell was identical scores across different instructions.

Running any of these materialises the model into `<repo>/models/` (~624 MB),
which is gitignored for that reason.

| eval | kind | answers |
|---|---|---|
| `isolation.eval.ts` | **invariant** — pass/fail | do identical leaves score identically? The spread is the noise floor for every score in the system. |
| `profiles.eval.ts` | **calibration** — numbers to read | does an instruction separate the distinctions it claims to, within a passage? |
| `footprint.eval.ts` | **resource** — measurement | what does the KV cache cost per quantisation type? |

## When to re-run

- **Swapping the reranker model.** `Rerank.ts` says it outright: re-run the
  calibration and update the fixtures. Canaries are Qwen3-Reranker-shaped.
- **Adding a `RerankInstruction`.** Its `smokeTest.minGap` and any threshold must
  clear the noise floor by a comfortable multiple, and a gate is only as good as
  its fixtures — the shipped ones test retrieval and validate nothing else.
- **Touching KV type, `nSeqMax`, `nCtx`, or the batching path.**

## What these established (2026-08-18)

**The KV cache type sets a noise floor on every score.** Six identical leaves,
measured spread:

| KV type | KV @ nCtx 4096 | noise floor |
|---|---|---|
| `q4_0` | 126 MiB | **1.270** logits |
| `q5_0` | 154 MiB | 0.813 — worse than q4_0 serially; avoid |
| `q8_0` | 238 MiB | 0.122 |
| `f16` | 448 MiB | **0.004** ← current default |

`q4_0` shipped from `v1.2.0` (2026-03-16) to `v5.1.0`, and its floor **exceeded
the boot canary's own `minGap` of 1.0** — the calibration gate was asserting a
separation it could not resolve. f16 was chosen over q8_0 because q8_0's floor
(0.122) is larger than the tightest margin measured (0.061).

Not a defect in `BranchStore`, `Rerank`, `decode_scatter` or the logits read —
each was read and verified. Quantisation alone: identical logical state,
different physical blocks, different dequantisation.

**The reranker is a relative ranker.** Within a passage it orders correctly
(4/4 groups). Across passages the scale shifts — global overlap 1.581. So score
it as *top-K within a query*, never as a global threshold. That is what
`FetchPageTool` already does (`scored.slice(0, topK)`, no boundary) and why
`SearchTool` documents its floor as "a discrimination signal, not an absolute
relevance line".

**Instruction wording dominates.** Compound instructions ("date AND actor AND
modality") invert the ranking — wrong-actor outscores verbatim. A cross-encoder
follows one criterion, not a conjunction of three.

**The two directions are different questions, not a fair race.**
`assertion-as-query` scores topically-distinct passages against one claim —
close to retrieval, wide margins (1.8–2.8), easy. `passage-as-query` scores
near-identical assertions against one passage — the real support judgement, and
thin (`factcheck` 0.135, `entailment` 0.059, `compound` inverted). Judge a
support instruction on the left column. An earlier revision compared the two as
if one were "7x better"; that came from scoring each pair under its own query
and comparing across queries — the very error this suite exists to document.
