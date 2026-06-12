# Rerank Eval Pack — PRE vs POST Report (2026-06-11)

## Verdict

**Same-pair scoring is unchanged across the entire 3.0 rerank stack change.**
The candidate explanations for the live-trace score shifts are now separated
with frozen-input evidence: it was the **candidate set** (BM25 first stage +
different query mixes), never the scoring.

## Setup

- **Fixtures**: 16 queries (5 vague / 6 refined / 2 hard regression sentinels /
  3 absent-topic floor probes) × 40 candidates each (BM25 top-30 through the
  model tokenizer + 10 seeded-random recall probes) = 640 frozen (query, chunk)
  pairs. Chunks from hdk-docs @ `784cc6313ed5` (dirty at build — flagged in
  manifest; re-freeze after the docs pile commits). Model:
  `qwen3-reranker-0.6b-q8_0.gguf` (the production catalog quant), nCtx 16384.
- **PRE** = committed lloyal-sdk (`edb21c8`, pre-rerank) via git worktree +
  npm `lloyal.node` 2.1.0 prebuilt (b8795-era) + nSeqMax 8 (its prod default).
- **POST** = working tree (R1 natives + R3 Rerank restructure) + local
  lloyal.node @ b9581 + nSeqMax 10 (#445).

## Results (all numbers from compare.mjs output, 2026-06-11)

| Comparison | τ min | top-5 overlap | top-1 changed | \|Δ\| med | \|Δ\| p95 | \|Δ\| max |
|---|---|---|---|---|---|---|
| Same-build replay (noise floor) | **1.000** | 5/5 ×16 | 0 | **0** | **0** | **0** (bit-exact, 100% byte-identical) |
| POST n10 vs n8 (batch composition) | 0.992 | 5/5 ×16 | 0 | 0.0012 | 0.0062 | 0.0093 |
| **PRE vs POST (the verdict)** | **0.992** | **5/5 ×16** | **0** | 0.0030 | 0.0086 | 0.0174 |
| PRE-n8 vs POST-n8 (composition held equal) | 0.995 | 5/5 ×16 | 0 | 0.0029 | 0.0088 | 0.0220 |

Tier 1 (rank order): **PASS** on every comparison.
Tier 2 (|Δ| p95 vs 5×noise-floor, floor = bit-exact ⇒ 0.05 absolute): **PASS**.
Tier 3 (informational): 0% byte-identical cross-build — expected (BLAS batch
splits, build flags); never a gate.

## What this resolves

1. **R3 assembly + b9581 numerics: exonerated.** Max same-pair drift 0.022
   logits (≈0.5% probability at the steepest point of the sigmoid). Top-1
   unchanged on all 16 queries; top-5 sets identical.
2. **Batch composition (6 vs 8 effective leaves): exonerated.** n8 vs n10
   max drift 0.009 logits, zero rank effects.
3. **The live PRE→POST shifts (8.41→3.86 tops, 10→3-6 hits) were candidate-set
   and query-mix effects** — BM25-100 gating changes WHICH chunks get scored,
   and the threshold changes which survive; the judge itself is unchanged.
4. **Floor behavior is healthy**: all 3 absent-topic probes score top-1 between
   −4.0 and −7.9 (P(yes) ≤ 0.02) on both sides — the floor-0 cut excludes them
   entirely, which is the designed behavior.

## Standing gate usage (future llama.cpp bumps)

```
# one-time per fixture revision (model tokenizer required):
LLOYAL_LOCAL=1 node build-fixtures.mjs
# per candidate build:
LLOYAL_LOCAL=1 node run-eval.mjs --out scores-<build>.json --nseq 10
node compare.mjs scores-<baseline>.json scores-<build>.json --floor noise-floor.json
```

Baseline committed: `scores-post-n10.json` (b9581, q8_0, nSeqMax 10).
Exit code 0 = both tiers pass.

## Open (non-blocking)

- Hand-labeled relevance judgments on the 16×top-10 sets (floor calibration +
  overview-chunk-bias quantification) — fixtures carry everything needed.

## Fixture provenance

The PRE-vs-POST verdict above was produced on fixture revision `784cc631`
(docs dirty at build — flagged in that run's manifests). Fixtures were
re-frozen at clean docs SHA `74e5d27d` (637 chunks) on 2026-06-12 with a new
committed baseline (`scores-post-n10.json`) and a fresh bit-exact replay
gate; old-revision score files were removed. The verdict numbers in this
report remain the authoritative PRE/POST record.
