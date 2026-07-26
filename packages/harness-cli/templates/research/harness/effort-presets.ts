/**
 * Run-effort presets — pure policy (KV/time budget + planner breadth + recovery
 * cap), NO prompt/semantic effect (that is `reasoningMode`'s job). Shared by the
 * harness (which applies them via `createResearchPolicy` / `runPlanner`) and the
 * Settings UI (which displays them). Plain data — no engine deps — so both the
 * engine bundle and the renderer can import it without dragging in `agents`.
 *
 * `high` reproduces the historical values byte-for-byte. The `medium`/`low`
 * numbers are starting estimates; calibration against live runs is expected.
 * The effort levers are: KV reserve (`context`), time budget, planner breadth
 * (`maxTasks`), and the reranker explore→exploit threshold (`shouldExplore`).
 */
export type Effort = 'low' | 'medium' | 'high' | 'ultra'

export interface EffortPreset {
  budget: {
    context: { softLimit: number; hardLimit: number }
    time: { softLimit: number; hardLimit: number }
  }
  /** Planner task cap — the fan-out breadth. */
  maxTasks: number
  /** Recovery-report token cap; omitted = headroom-derived (the fold default). */
  reportBudget?: number
  /**
   * Reranker explore→exploit KV threshold (`DefaultAgentPolicy.shouldExplore`).
   * `context` = the fraction of KV that must still be AVAILABLE to keep EXPLORING
   * (relaxed retrieval that can surface novel facts); below it, switch to EXPLOIT
   * (strict dual-entailment scoring vs the task AND the original query). LOWER
   * `context` = explores LONGER. Omitted = framework default (0.4). See
   * reference_exploit_mode (strict `min(taskScore, queryScore)` vs relaxed).
   */
  shouldExplore?: { context: number }
}

export const EFFORT_PRESETS: Record<Effort, EffortPreset> = {
  // ULTRA — the ceiling tier, hand-tuned for a large (~1M-token) nCtx. NOTE: the
  // context limits are ABSOLUTE free-KV reserve floors, NOT nCtx-derived — nothing
  // here auto-scales from the context window; these are hand-authored (see the
  // module header). `maxTasks: 10` is past the planner's tested `>6` boundary
  // ("shared-spine overflow" territory) — unproven, worth a real run to calibrate.
  ultra: {
    budget: {
      // ~4× high — extra recovery/report headroom for a 10-task fan-out at ~1M nCtx.
      context: { softLimit: 8192, hardLimit: 4096 },
      // 10 min soft / 15 min hard — 10 tasks against a large model.
      time: { softLimit: 600_000, hardLimit: 900_000 },
    },
    maxTasks: 10,
    // Explore until 75% KV used (25% available) — hunts novel facts even longer
    // than high (0.4) before tightening to strict dual-entailment retrieval.
    shouldExplore: { context: 0.25 },
  },
  high: {
    budget: {
      context: { softLimit: 2048, hardLimit: 1024 },
      time: { softLimit: 240_000, hardLimit: 360_000 },
    },
    maxTasks: 6,
    // Explore until 60% KV used (40% available), then exploit — the framework
    // default; high hunts novel facts the longest before tightening.
    shouldExplore: { context: 0.4 },
  },
  medium: {
    // Reserve ~20-25% of a 32k context so the parallel (low/medium) in-loop
    // recovery reports bin-pack whole. Interim ABSOLUTE values — nCtx-relative
    // scaling is the follow-up. reportBudget dropped: the in-loop headroom share
    // (clamped to MAX_REPORT_BUDGET=2048) governs, so the reserve makes reports
    // whole without a hard per-report cap.
    budget: {
      context: { softLimit: 8192, hardLimit: 6144 },
      time: { softLimit: 150_000, hardLimit: 240_000 },
    },
    maxTasks: 4,
    // Explore until 40% KV used (60% available), then exploit — some novelty up
    // front, then lock to strict relevance with recovery room still banked.
    shouldExplore: { context: 0.6 },
  },
  low: {
    budget: {
      context: { softLimit: 10240, hardLimit: 8192 },
      time: { softLimit: 90_000, hardLimit: 150_000 },
    },
    maxTasks: 2,
    // Always exploit — strict on-topic (dual-entailment) retrieval from turn 1.
    // Quick + shallow: converge on relevance fastest, recovery fits easily.
    shouldExplore: { context: 1.0 },
  },
}

/** Display order for UI (lightest → heaviest). */
export const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'ultra']
