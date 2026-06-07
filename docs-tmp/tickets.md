# Reasoning.run pipeline tickets

> Distilled from the agent-pathology investigation of `2026-05-26T03-35-27-016/`
> (trace: `trace-2026-05-26T03-04-59-214.jsonl`).
>
> Priority axis: **leverage on report quality + correctness × frequency of harm**.
> Scope tag: `framework` = `packages/{agents,rig,sdk,apps/*}`; `reasoning.run` =
> the harness; `native` = `lloyal.node` C++ binding. Several tickets are
> reasoning.run-local fixes to limitations that should eventually graduate.
>
> **Status legend:** ✅ done · ⏳ pending · 🔍 subsumed · 🚧 in progress

---

## P0 — Pool throughput architecture

### TICK-021 · Dispatch on tick fiber stalls entire pool during tool execution
**Scope:** `framework` (`packages/agents/src/agent-pool.ts` tick loop + dispatch)
**Severity:** highest — negates HDK's batched-decode amortization in practice
**Status:** ⏳ pending

**Evidence**

`trace-2026-05-26T03-04-59-214.jsonl`, pool #5 (research, 4 agents): 51
`agent:turn` events across 880 s = **~17 s per turn average**. With 4 active
agents and batched decode at ~100-200 ms per tick on M-class hardware, sustained
ticking should yield tens of milliseconds per agent-turn, not seconds. The
~100× gap is the tick fiber parked in DISPATCH while tool calls execute.

User-visible signature: agents stream tokens in perfect lockstep (one token
per agent per tick = batched llama_decode of N sequences), then ALL agents
freeze when ANY one agent's tool call lands in DISPATCH — including the three
that aren't awaiting and have a sampled token ready.

**Root cause**

The tick loop is one fiber. Phases 0-5 run as sequential `yield*` statements
inside one `for (;;)`:

```ts
for (;;) {
  // Phase 0: SPAWN+EXTEND
  // Phase 1: PRODUCE
  for (const a of agents) {
    if (a.status !== 'active') continue;   // filter — correct
    ...produceSync()...
  }
  // Phase 2-3: SETTLE
  // Phase 4: DISPATCH
  const dispatched = yield* dispatch(toolCalls);
  //   ↑ inside dispatch():
  //     for (const call of calls) {
  //       yield* call(() => tool.execute(...));  ← suspends the fiber here
  //     }
  // Phase 5: implicit COMMIT
}
```

When `tool.execute()` yields, iteration N is suspended at Phase 4. Iteration
N+1 (which would PRODUCE for active agents B/C/D while A is `awaiting_tool`)
can't start until N completes. The `status !== 'active'` filter is doing its
job — but the loop containing it never gets to run.

This defeats the foundational HDK story (BranchStore amortizes N branches into
1 llama_decode per tick). The amortization assumes ticks happen *often*. A
29 s reranker dispatch is 290 ticks worth of evaporated decode throughput
across the whole pool, not just the calling agent.

**Why it was written this way**

The `agent-pool.ts:1024` comment "Concurrent native calls on the same
llama_context → SEGV" set a conservative single-fiber posture across all
operations. The constraint is real per-context (model context, reranker
context), but blanket-applied to all tool dispatches it's strictly stronger
than needed.

**Fix shape**

1. **Detach dispatch fibers.** Phase 4 spawns each tool call on its own
   Effection fiber instead of `yield* call(...)`. The tick loop continues
   to the next iteration immediately.
2. **Settle via channel.** Tool completion pushes a `SettledTool` onto a
   per-pool channel. Phase 2 SETTLE drains the channel each tick, prefilling
   whatever results have landed (batched into one `store.prefill` as today).
3. **Per-context coordination.** Tools sharing a native llama_context
   (reranker: `search`, `fetch_page`) serialize against each other through
   a per-context queue/mutex. Tools with no native context affinity
   (`web_search`, `grep`, `read_file`) run fully concurrently with anything.
4. **Store-fiber invariant preserved.** Only the tick loop fiber issues
   `store.commit` / `store.prefill` on the model context. Dispatch fibers
   only touch *their* tool's backing system.
5. **Route `EntailmentScorer.scoreRelevanceBatch` through `Rerank.score`
   iterator** (safe under multi-request multiplex via `_drain`+`_fillGroup`)
   instead of `scoreBatch` direct path (races `_scoreGroup` on shared
   llama_context). Without this, concurrent search/fetch_page dispatches
   through the same reranker context would race even inside a per-context
   queue (because EntailmentScorer bypasses the queue's drain).

**Expected impact**

For pool 4's 880 s baseline:

- N-1 active agents keep producing during any single tool window. With 4
  agents and 1 in `awaiting_tool` for 29 s: ~870 tokens produced by the other
  3 instead of 0.
- 14 of 23 tool dispatches in pool 4 are no-native-context (12 `web_search`
  + 2 `read_file`) — they run fully parallel under detached dispatch.
- Reranker-touching tools (7 `search` + 2 `fetch_page`) still serialize, but
  concurrently with model decode rather than blocking it.
- Rough envelope: 2-3× pool throughput improvement on tool-heavy queries.
  Conservative estimate; depends on how many ticks of stall pool 4 is
  paying.

**Sub-tasks**

- 21.0: Investigation — read tick loop, settle, dispatch, scope structure.
  Map every coupling between dispatch and the tick fiber. Identify the
  `awaiting_tool` → `active` transition site (currently inline in dispatch).
- 21.1: Design per-context coordination primitive (per-context fiber + channel
  vs. per-context mutex). Effection-idiomatic; cancellable.
- 21.2: Implement detached dispatch fibers + settle channel. Move
  `awaiting_tool → active` transition into SETTLE.
- 21.3: Implement per-context serialization for reranker-touching tools.
- 21.4: Refactor `EntailmentScorer.scoreRelevanceBatch` to use
  `Rerank.score()` iterator path.
- 21.5: Update trace event ordering assumptions in `analyze-trace.py` and
  TUI reducer (`reasoning.run/src/tui-ink/reducer.ts`) — events now
  interleave by wall time, not by tick phase.
- 21.6: Pool teardown — explicit fiber cancellation for in-flight dispatches.
- 21.7: Tests — scenario test: pool with one slow tool + N agents, assert
  the N-1 active agents keep producing.
- 21.8: Re-run canonical query baseline; compare via `analyze-trace.py`.

**Subtleties**

- Trace event ordering: detached fibers emit events interleaved with the
  tick loop's, not strictly sequential by phase. `analyze-trace.py` already
  uses per-pool-window timestamps so should largely cope; reducer
  assumptions need a pass.
- `peerHistory` snapshot timing (`agent-pool.ts:854`): currently captured
  before `tool.execute`. Under detached dispatch, captured as "peer history
  at the tick that initiated this dispatch" — which is the right semantics.
- Recovery: `recoverInline` (called from tick loop today) is unaffected;
  it's a tick-fiber operation on the model context, never a dispatch fiber.

**Relation to other tickets**

- **Subsumes TICK-016** (kill-rate-limiting under parallel pool) — that
  symptom is a function of the same single-fiber stall.
- **Reduces urgency of TICK-007** (lazy time-hard kill) — kills land on
  tick boundaries; ticks happen at full cadence regardless of dispatch.
- **Should land BEFORE TICK-011 + TICK-012.** Those make agents do *more*
  tool calls; without TICK-021 they degrade wall throughput further.
- **Independent of TICK-001 / TICK-002** (different layer). Phase 1's
  reranker calibration fix is orthogonal and already shipped.

---

## P0 — Tool-layer signal correctness

These compound: every stage downstream consumes corpus-search output. Fixing
these attenuates the agent / prompt / synth pathologies below without further
work.

### TICK-001 · Corpus `search` returns top-K regardless of relevance
**Scope:** `framework` (`packages/apps/corpus/src/tools/search.ts`)
**Severity:** high — root cause of recon misclassification class
**Status:** ✅ **DONE** (Phase 1, 2026-05-26). `SearchTool` now returns
`{hits, thresholdScore, totalScored, topRejected}` envelope with logit-diff
threshold (default 0). New constructor opt `{ threshold?: number }`. Tests
in `packages/apps/corpus/test/app.test.ts` ("SearchTool envelope" suite).
Follow-up patch 2026-05-27: `totalScored` was reading `results.length`
(topK-truncated to 10 by `reranker.score`) — fixed to use the iterator's
`total` field so the envelope reports the actual corpus-scored count.

**Evidence**

`search("firefox extension")` against a corpus with **zero firefox content**
returned 10 HDK chunks (top: `reference/continuous-context-spine.md`,
`score: 0.999`). The tool returns top-K by score, never empty. Recon sees
high-scoring "results" and naturally infers presence.

**Root cause**

`SearchTool` ranks all chunks and slices the top-K — there is no relevance gate
on the returned list. The `EntailmentScorer` has a `_entailmentFloor = 0.25`
constant but it gates tool-result *delivery*, not the `search` tool's own
results.

**Fix**

Add a score threshold to `SearchTool`: hits below the threshold are dropped;
return `[]` if everything is below. Make the threshold + the saw-but-dropped
count visible in the result envelope so the model gets an honest "0 hits above
0.5" signal:

```jsonc
{
  "hits": [],
  "thresholdScore": 0.5,
  "totalScored": 484,
  "topRejected": [{ "score": 0.21, "file": "..." }]
}
```

**Depends on TICK-002** (calibration) for the threshold to mean what it says.
Until then, a rank-based filter ("only return top-K above a Z-score") is a
defensible interim.

---

### TICK-002 · Reranker scores are miscalibrated across queries
**Scope:** `framework` (rerank pipeline); investigation may extend to `native`
(reranker model or scoring impl)
**Severity:** high — invalidates score-based decision-making everywhere
**Status:** ✅ **DONE** (Phase 1, 2026-05-26). `Rerank._rerankScore` switched
from `softmax(yes, no)` to `logit(yes) − logit(no)` (`packages/sdk/src/Rerank.ts`).
`Source._entailmentFloor` recalibrated 0.25 → 0 for logit-diff semantics
(`packages/agents/src/source.ts`). Calibration probe shows median(rel) −
median(irrel) = **3.66** (target ≥ 0.30 ✓); off-topic top score **−1.04**;
API-identifier top score **+5.54**. Diagnostic at
`reasoning.run/scripts/inspect-rerank.mjs`. Tests in
`packages/sdk/test/rerank.test.ts` ("Rerank score formula" suite).

**Evidence (one run, seven corpus searches)**

| query                                            | top score                |
| :----------------------------------------------- | :----------------------- |
| "firefox extension" (corpus has 0 firefox)       | **0.999**                |
| "Lloyal Harness Development Kit"                 | 0.999                    |
| "continuous context spine"                       | 1.000                    |
| "agent pool persistent stateful session"         | 0.999 × 5 (saturated)    |
| "useAgentPool useSpine session" (exact API match) | **0.017**                |

The off-topic query scores ~60× higher than the perfectly-matching one. Likely
contributors:

- **Tokenization** — camelCase API identifiers don't tokenize as recognizable
  units in the cross-encoder; relevance collapses.
- **Cross-encoder bias toward plausible-prose** — chunks of well-formed text
  score high regardless of literal-keyword match.

**Fix**

Investigation, in order:
1. Verify the score field's source in `Rerank.ts` — is it really last-token P(yes),
   or has it been transformed?
2. Test against a held-out relevance set (10 queries × known-relevant chunks).
3. If miscalibration confirmed: (a) consider rank-based normalization
   (within-query Z-score) instead of raw probabilities; (b) consider
   pre-tokenizing API identifiers (`useAgentPool` → `use Agent Pool`); (c)
   audit whether reranker model swap (a larger or differently-trained reranker)
   would change calibration.

**Blocks meaningful TICK-001 threshold** because the threshold has to be set
against a trustworthy score scale.

---

### TICK-003 · Reranker score saturates at ≈0.999
**Scope:** `framework` / `native`
**Severity:** medium — hides top-K ordering, complicates threshold-based
filtering
**Status:** 🔍 **SUBSUMED by TICK-002** (Phase 1, 2026-05-26). Logit-diff is
unbounded by construction; top-5 stddev rose from 0.05-0.5 (softmax,
saturated) to 2.5-6.5 (logit-diff). Saturation eliminated at the formula
layer.

**Evidence**

Query "agent pool persistent stateful session" returned five consecutive
hits all at `score: 0.999`. Top-5 ordering is meaningless above ~0.99.

**Fix**

Diagnose whether saturation is in the underlying probability output (e.g.,
softmax pile-up near 1.0) or in a serialization rounding step. If logits, use
a sharper scoring (e.g., logit difference instead of P(yes)). If serialization,
emit more decimal places.

Pairs with TICK-002 — same investigation surface.

---

### TICK-004 · Recon re-runs entirely on every clarify-answer round-trip
**Scope:** `reasoning.run` (`src/harness.ts` runQuery, or `src/main.ts`
submit_clarification path)
**Severity:** high — ~150 s per re-plan, plus degraded coverage on the re-run
**Status:** ✅ **DONE** (2026-05-27). Idiomatic Effection fix, not a flag:
preflight coverage is now a memoized `resource()`. `createCoverageCache()`
(harness.ts) provides a `getOrCompute(query, compute)` handle, set once on
`CoverageCacheCtx` at the command-loop scope (main.ts ~556). `runQuery` calls
`useCoverage(query, session)` (which holds the ≥2-app gate + memo) instead of
the old `if (≥2 apps) runPreflight` branch. Clarify / change_mode re-invoke
`runQuery(sameQuery)` → cache hit → no second probe, no `preflight:*` re-emit.
The rejected `reusableCoverage?`/`skipPreflight?` flag was never shipped.
Cache key = `query` (enabled-app set is constant within a boot scope; a
`/model`/`/reranker` restart unwinds the scope and rebuilds the cache).
reasoning.run tsc + build + smoke green; 343 framework tests green.
Behavioral diff pending re-run. Design: `mutable-waddling-bentley.md`.

**Evidence**

For one query that fired one clarify question:
- Pool #1 (recon round 1, before clarify): 167 s, 5 dispatches, voluntary
  reports, ~865-char coverage.
- Pool #3 (recon round 2, after user answers clarify): 148 s, 5 dispatches, both
  agents force-recovered, ~240 tokens of combined coverage.

The corpus and the web didn't change between the two rounds — only the user's
clarification answer did. Recon was redone identically, slower this time
because clarify-answer in the context eats turns 0-1 before searches dispatch.

**Fix**

Memoize `runPreflight` output per `session` per `query` until a research run
completes. On `submit_clarification`, reuse the round-1 coverage and pass it
forward into the planner context as-is — only the user-Q&A context changes for
the planner.

Implementation seam: `pendingPlan` can carry the recon coverage; new runQuery
opts (`reusableCoverage?: string`) check before invoking `runPreflight`.

---

### TICK-005 · Source content surface not visible to recon agents
**Scope:** `reasoning.run` (`runPreflight` → `reconCtx.apps`); proper graduation
to `framework` later
**Severity:** **promoted to highest** — confirmed load-bearing for planner routing
**Status:** ✅ **DONE** (Phase 1.5, 2026-05-27). `runPreflight` now duck-types
`app.source.promptData()?.toc` into the per-app probe context as `contents`
(`reasoning.run/src/harness.ts:346-358`). `preflight.eta` renders the
Contents block above the search-tool line with explicit instructions:
"Read Contents BEFORE searching … if Contents names the acronym expansion,
don't invent an alternative." Build + tsc + smokes + 343 framework tests
green. Behavioral diff pending re-run with the canonical HDK query.

**Behavioral evidence — `trace-2026-05-26T14-14-35-245.jsonl`, 2026-05-27 run:**

For the HDK + Firefox + Qwen 3.5 query, the corpus recon agent searched HDK
chunks and reported (per `agent:turn.rawOutput`):

> "The search for 'firefox extension' returned results mostly about agents,
> spines, and RAG — nothing about Firefox extensions. The corpus seems to be
> about Lloyal (the platform), not browser extensions."

> "The search for 'lloyal hdk' returned results about Lloyal's primitives,
> pipelines, and development concepts — but nothing specifically about 'HDK'
> (Harness Development Kit). The corpus seems to be about [Lloyal platform]."

The corpus *IS* the HDK docs. Without TOC visibility, the agent reads HDK
chunks as "Lloyal platform stuff, not HDK" — fails to recognize the corpus's
identity. Both recon agents force-killed at `RECON_MAX_TURNS=4`, thin
recovery (143 / 101 tokens), empty `RECOVERY-RETURN.result`. Planner saw
"corpus → nothing useful, web → HDK confirmed" and routed all 3 tasks to
`web_research` (including task #1: "Survey the Lloyal HDK documentation").

This is the entire planner-routing collapse the user observed. Fixing TICK-005
should restore correct app routing for HDK queries.

**Evidence**

Recon's corpus probe agent in round 1 saw `Lloyal Harness Development Kit`
result chunks but reported *"zero mentions of HDK (Headless Development Kit)"*
— hallucinating an alternative HDK expansion because nothing told the agent
"the corpus IS the HDK docs." The corpus app exposes `promptData().toc` (used
by `buildPlannerContext` for the planner) but not by recon.

**Fix**

In `runPreflight`'s `reconCtx.apps[i]`, add the source's content surface (duck-typed
`app.source.promptData()` for now; corpus surfaces TOC). Render it into
`preflight.eta` per app:

```eta
Source: <%= a.name %> — <%= a.useWhen %>
Contents: <%= a.contents %>   <!-- ← new -->
```

This is reasoning.run-local. Graduation to framework: add `Source.describe()`
to the base `Source` class; corpus overrides with TOC, web returns "the open
web", a future Jira returns project keys, etc. (separate ticket, TICK-018).

---

## P1 — Per-pool / per-stage compliance

### TICK-006 · Research policy has no hard turn cap (only time/KV hard limits)
**Scope:** `framework` (`packages/agents/src/AgentPolicy.ts` +
`reasoning.run/src/harness.ts createResearchPolicy`)
**Severity:** medium-high — agents 6 and 131076 each ignored 7+ nudges before
being dropped on time-hard
**Status:** ⏳ pending (Phase 4)

**Evidence**

In pool #5 (research): 17 nudges across 4 agents. Two agents (6, 131076)
ignored every nudge. Agent 6 was dropped at 349 s (close to time-hard 360 s),
but agent 131076 was dropped at 492 s — **132 s past time-hard**. Either
`shouldExit`'s `_killedThisTick` trailing-stop is rate-limiting kills, or
time-hard isn't checked every tick.

The recon policy got a hard turn cap (`ReconPolicy.shouldExit` at
`turns >= RECON_MAX_TURNS`). Research didn't.

**Fix**

Mirror `ReconPolicy` for research: a `RESEARCH_MAX_TURNS` (≈12) → kill +
`recoverInline`. Existing recovery prompt produces useful 1000-2000-token
annexure content; this just makes the drop predictable instead of
time-hard-dependent.

Pairs with TICK-007 (the time-hard lazy kill).

---

### TICK-007 · Time-hard kill fires lazily (kill happens past `time.hardLimit`)
**Scope:** `framework` (`packages/agents/src/AgentPolicy.ts shouldExit`,
`agent-pool.ts` tick loop)
**Severity:** medium — research agents run ~30 % past hardLimit before being
killed
**Status:** ⏳ pending (Phase 4) — urgency reduced by TICK-021 (tick cadence
under tool dispatch becomes normal once dispatch is detached, so time-hard
kills land on tick boundaries close to their actual deadline).

**Evidence**

Agent 131076's `createResearchPolicy.time.hardLimit = 360_000 ms`. Dropped at
492 s = 132 s past hard. Pattern repeats: kills are staggered across parallel
agents.

**Root cause hypothesis**

`shouldExit` is called once per agent per tick, but `_killedThisTick` rate-limits
to one kill per tick. With four parallel agents all in nudge-loop, only one
gets killed per tick — the rest keep producing until their turn comes around.

**Fix**

Either remove `_killedThisTick` for time-hard (it's a graceful shutdown, not
KV-critical) — kill all over-time agents in one pass — or process agents in
priority order so time-hard candidates are killed first. Investigate before
patching.

---

### TICK-008 · Nudge messages don't escalate
**Scope:** `framework` (`AgentPolicy.ts _handleOverBudget`)
**Severity:** low-medium — affects compliance rate
**Status:** ⏳ pending (Phase 4)

**Evidence**

The same nudge string (*"Time limit reached — report your findings now within
N words."*) fired up to 8× per agent. After the second identical nudge the
model has demonstrated it isn't going to comply on this prompt.

**Fix**

Stage 2 escalation after N ignored nudges:

> "You have ignored {N} report nudges. Calling `report` is now mandatory — your
>  next non-report action will end the agent and your unreported findings will
>  be lost."

Or: bind escalation to imminent forced termination (TICK-006).

---

### TICK-009 · Synth treats null annexures as design constraints
**Scope:** `reasoning.run` (`src/prompts/synthesize.eta` / `synthesize-flat.eta`)
**Severity:** medium — propagates user-introduced phantom terms into the
report's load-bearing framing
**Status:** ⏳ pending (Phase 3)

**Evidence**

Annexure-1 was a "Status: Unable to locate 'Silent Nano Install' pattern"
report. The synth used this as evidence-of-a-gap-to-design-around, devoting a
"Handling the Terminology Gap" subsection and threading the phantom through
the entire architecture. Intellectually honest but content-damaging: a reader
who skips Limitations walks away thinking "Silent Nano Install" is a real
performance profile to aim for.

**Fix**

Synth prompt instruction:

> If a key term appears in a task description but no annexure produces direct
> evidence of it existing (sources, definitions, links), treat the term as
> unverified. Do NOT design the recommendation around it. Note its absence in
> a single Limitations bullet and structure the report around what IS
> documented.

---

### TICK-010 · Synth has no anti-redundancy guidance
**Scope:** `reasoning.run` (`synthesize.eta`)
**Severity:** low — wordiness, not correctness
**Status:** ⏳ pending (Phase 3)

**Evidence**

The dual-engine thesis appears verbatim three times in the 14 KB report:
Thesis, Resolution intro, Conclusion. ~30 % of the report is the same
architectural claim slightly rephrased.

**Fix**

Synth prompt: "State each load-bearing claim once. Conclusion = one paragraph
that names the recommendation; do not restate the thesis."

---

## P2 — Per-agent / per-prompt class fixes

### TICK-011 · Web research agents skip `fetch_page` after finding URLs in search
**Scope:** `reasoning.run` (`packages/apps/web/skill.eta` or web research
prompt)
**Severity:** medium — degrades grounding; reported content from search
snippets risks confabulation
**Status:** ⏳ pending (Phase 3) — defer until **after TICK-021**; more
fetches without detached dispatch would worsen wall throughput.

**Evidence**

Agent 131075 (web · MDN/Firefox APIs): 4 web_searches, 0 fetches. Search
snippets contained MDN URLs but the agent never fetched the full pages. The
search-only pattern persists across traces.

**Fix**

Prompt addition: "After 2-3 web_searches, fetch the top URL from the most
relevant result. Reporting from search snippets alone is insufficient
grounding." Pairs with a soft policy that nudges after N consecutive searches
without a fetch.

---

### TICK-012 · Research agents chase fabricated terms without decomposing
**Scope:** `reasoning.run` (`packages/apps/web/skill.eta`)
**Severity:** medium — wastes pool time + KV; recovery scratchpad rescues
findings but the wasted turns block other agents
**Status:** ⏳ pending (Phase 3) — defer until **after TICK-021** for the
same throughput reason as TICK-011.

**Evidence**

Agent 131076 searched 8× for permutations of "Silent Nano Install Chrome
extension HDK" — a user-introduced term that doesn't exist in any source.
After 2-3 nulls a human researcher decomposes; the agent kept permuting.

**Fix**

Prompt addition:

> If your first 3 searches for a specific multi-word term return no relevant
> results, decompose the term into its constituent concepts and search for
> those individually.

A policy-level guard ("after 3 consecutive low-relevance results for the same
literal term, inject a decomposition nudge") would be more robust, but the
prompt is the cheap interim.

---

### TICK-013 · Planner task descriptions miss deployment-context constraints
**Scope:** `reasoning.run` (`src/prompts/plan.eta` / `plan-flat.eta`)
**Severity:** medium — drives research agents to the wrong target
**Status:** ⏳ pending (Phase 3)

**Evidence**

Planner task #3 for the firefox-extension query: *"Survey the technical
specifications and release notes for Google's Gemini model (as of 2026) to
determine the optimal local inference configuration."* Vague about Pro vs.
on-device. Agent 5 fetched the **cloud Gemini 3.1 Pro** model card (1 M context)
for a question about *browser-extension local inference*. Right target was
Gemma-Nano-class.

**Fix**

Plan prompt rule: when the query implies a deployment context (browser,
on-device, local, server, embedded), thread it into every task description that
involves model selection or hardware specs. Concrete example in the few-shot:

```jsonc
{
  "description": "Survey on-device-capable Gemini model variants
  (Nano/Gemma-class, ONNX-compatible) for Firefox AI Runtime
  (browser.trial.ml) — quantization, context window, memory footprint.",
  "app": "web_research"
}
```

---

### TICK-014 · Recon turn-cap is too tight on clarify-followup runs
**Scope:** `reasoning.run` (`src/harness.ts ReconPolicy` /
`createReconPolicy`)
**Severity:** low — only matters if TICK-004 isn't done; subsumed if it is
**Status:** 🔍 **SUBSUMED by TICK-004** (2026-05-27). With coverage memoized,
recon never runs a second time on clarify-followup — so there is no second
recon to mis-cap. Closed.

**Evidence**

Round-2 recon agents (after clarify-answer) hit `RECON_MAX_TURNS = 4` at
~115 s with 2-3 dispatched searches. Round 1 had room for voluntary reports;
round 2 dropped both agents on the cap → shorter recovered coverage.

**Fix**

Either:
(a) Skip recon round 2 entirely (TICK-004 cache).
(b) Bump `RECON_MAX_TURNS` to 5 only in clarify-followup runs (planner context
    has more tokens; the +1 turn buys the voluntary-report window).

Prefer (a).

---

### TICK-015 · `minToolCalls` is a poor recovery-quality predictor
**Scope:** `framework` (`AgentPolicy.ts onRecovery`)
**Severity:** low — affects whether recovery fires; doesn't fix poor
recovery output
**Status:** ⏳ pending (Phase 4)

**Evidence**

- Round-2 recon agents: passed `minToolCalls: 1` (my override), recovered
  105 and 133 tokens. Thin.
- Research agents 6, 131076: passed `minToolCalls: 2` (default), recovered
  2045 and 1097 tokens. Substantive.

The gate doesn't predict recovery quality. Token count of the agent's KV
correlates better.

**Fix**

Replace `minToolCalls` with `minTokens` (already exists, default 100) as the
primary gate, drop or de-emphasize `minToolCalls`. Tune `minTokens` upward
(~300?) so thin recoveries get skipped rather than producing token-budget
waste.

---

### TICK-016 · Pool kill-rate-limiting may stall recovery on parallel pools
**Scope:** `framework` (`AgentPolicy.ts _killedThisTick`, tick loop in
`agent-pool.ts`)
**Severity:** low — investigate before patching
**Status:** 🔍 likely subsumed by **TICK-021** — the symptom (kills staggered
143 s apart across parallel agents) is a function of the same single-fiber
stall. Detached dispatch + tick at normal cadence means time-hard kills
land within a tick of their deadline. Re-evaluate after TICK-021 lands.

**Evidence**

Pool #5: 4 parallel research agents, 17 nudges, 2 dropped (one at 349 s, one
at 492 s — 143 s apart). The trailing-stop ("one kill per tick") was designed
for KV-headroom hygiene. For time-hard kills it just delays the inevitable.

**Fix**

Audit: when does `_killedThisTick` actually save us, vs. just slow things
down? If time-hard / policy-exit kills don't need rate-limiting, separate the
flag from those paths.

---

### TICK-017 · `tool:dispatch.durationMs` is always 0 in trace
**Scope:** `framework` (`agent-pool.ts` trace writer for `tool:dispatch`)
**Severity:** low — observability only
**Status:** ⏳ pending (Phase 5) — interacts with TICK-021: under detached
dispatch, the natural place to emit duration is on the dispatch fiber's
completion path, not at the tick boundary.

**Evidence**

Every `tool:dispatch` event in `trace-2026-05-26T03-04-59-214.jsonl` has
`durationMs: 0`. Actual durations are reconstructible from `ts` deltas but
not on the event itself.

**Fix**

Either (a) emit `tool:dispatch` after dispatch completes with real `durationMs`,
or (b) drop the field. Currently it's misleading.

---

## P3 — Polish / observability

### TICK-018 · Graduate `source.describe()` to `framework`
**Scope:** `framework` (`packages/agents/src/source.ts` base class + corpus +
web overrides)
**Severity:** low — until a second harness needs the same hook
**Status:** ⏳ deferred (Phase 6 / YAGNI)

**Summary**

`TICK-005`'s reasoning.run-side fix duck-types `app.source.promptData()`. The
graduated framework affordance: add `Source.describe(): string` (or
`promptData(): Record<string,unknown>` if the structured form is needed) to
the `Source` base class. Corpus implements via TOC; web returns a short
self-description; Jira would list project keys; Databricks would list
schemas.

Defer until a non-reasoning.run harness needs the same affordance. YAGNI
otherwise.

---

### TICK-019 · Synth duration discrepancy (trace 136 s, report header 1024 s)
**Scope:** investigate; could be `reasoning.run` (report header generation),
`framework` (synth pool tracing), or just a labelling bug
**Severity:** low — observability
**Status:** ⏳ pending (Phase 5)

**Evidence**

Pool #6 (single agent 196611, no tools) opens and closes in 136 s in the
trace. The report header reads `· 1024.0s` labelled as synth-related. Either
labelling is wrong or synth runs outside instrumented pool boundaries.

**Fix**

Read where the "1024.0s" comes from in the synth flow; reconcile with pool
duration. Likely a `finalize` event using `wallStartMs` (total run wall time)
mislabeled as synth time.

---

### TICK-020 · Agent ID renumbering across pools is hard to follow
**Scope:** observability — `framework` (id allocation) or trace-tooling
**Severity:** low — cosmetic, harms offline trace analysis
**Status:** ⏳ pending (Phase 5)

**Evidence**

In one run, agent IDs went: `3, 4` → `65538` → `65539, 65540` → `196610` →
`5, 6, 131075, 131076` → `196611`. The high IDs are 16-bit-offset branch
handles from native; the research IDs look like a different allocation
space.

**Fix**

Either expose a stable per-pool sequential index in trace events
(`poolAgentIndex: 0, 1, 2, …`) alongside the native handle, or document the
ID scheme. Pure observability.

---

## Cross-ticket fix order (by leverage)

| Phase | Status | Tickets                  | Notes                                              |
| :---- | :----- | :----------------------- | :------------------------------------------------- |
| 1     | ✅ done | TICK-001, TICK-002, TICK-003 | Tool-layer signal correctness. Logit-diff fix    |
|       |        |                          | shipped 2026-05-26. `totalScored` follow-up patch  |
|       |        |                          | 2026-05-27.                                        |
| **1.5** | ✅ done | **TICK-005**            | **Shipped 2026-05-27.** Corpus TOC now threaded    |
|       |        |                          | into preflight.eta as Contents advert above the    |
|       |        |                          | search-tool line. Prompt explicitly directs the    |
|       |        |                          | agent to disambiguate acronyms against Contents    |
|       |        |                          | before inventing alternative expansions.           |
| 2     | ⏳     | **TICK-021**             | Pool throughput architecture. Headline framework   |
|       |        |                          | lever. Behind TICK-005 because without correct     |
|       |        |                          | routing, faster dispatch just gets us to a wrong   |
|       |        |                          | answer faster.                                     |
| 3     | ✅ done | TICK-004 (+TICK-014)    | Recon-cache wiring. Shipped 2026-05-27 as a        |
|       |        |                          | memoized Effection `resource()` (CoverageCache),   |
|       |        |                          | not a flag. TICK-014 subsumed.                     |
| 4     | ⏳     | TICK-009, TICK-010,      | Synth + planner + web prompt fixes. Defer 011/012  |
|       |        | TICK-013, (TICK-011,     | until after TICK-021 lands (they add tool calls).  |
|       |        | TICK-012)                |                                                    |
| 5     | ⏳     | TICK-006, TICK-007,      | Research compliance + recovery tuning. TICK-016    |
|       |        | TICK-008, TICK-015,      | likely subsumed by TICK-021.                       |
|       |        | (TICK-016)               |                                                    |
| 6     | ⏳     | TICK-014, TICK-017,      | Polish + observability.                            |
|       |        | TICK-019, TICK-020       |                                                    |
| 7     | ⏳     | TICK-018                 | Deferred (YAGNI until second harness needs it).    |

---

## Out of scope (deliberately not tickets)

- **Recon agent's "Headless Development Kit" hallucination** as a standalone
  issue: it's a downstream symptom of TICK-001 + TICK-002 (corpus search
  handed the agent garbage-shaped-as-evidence). Fixing 001+002 removes the
  conditions that produced the hallucination.
- **Agent 6's nudge-ignoring as a "useful additional research" pattern:**
  rewarding nudge-ignoring is the wrong incentive — the same content was
  available 3 turns earlier. Subsumed by TICK-006.
- **"Silent Nano Install" propagation:** the phantom entered via the user's
  clarify-answer (the planner amplified it but didn't invent it from
  nothing). A user-side hallucination is in scope for the harness only via
  TICK-009 (synth audit) and TICK-012 (decompose-after-N-nulls). Refusing to
  proceed with the user's term isn't the right call — the harness can't
  litigate user input.
