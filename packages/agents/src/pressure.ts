import type { SessionContext } from '@lloyal-labs/sdk';
import type { PressureThresholds } from './types';

/** What the store reports: `{ nCtx, cellsUsed, remaining }`, `remaining = nCtx - cellsUsed`. */
type KvReading = { nCtx: number; cellsUsed: number; remaining: number };

/**
 * Immutable KV budget snapshot — a VALUE the scheduler decides against.
 *
 * The pool samples it once per tick (`TickState.pressure`) and derives the
 * post-admission value arithmetically with {@link minus}; effect records read
 * the store again at landing time. Either way a snapshot never changes after
 * it is taken, so every decision made against one is order-independent.
 *
 * Created from `SessionContext._storeKvPressure()` which returns
 * `{ nCtx, cellsUsed, remaining }` where `remaining = nCtx - cellsUsed`.
 * `cellsUsed` tracks unique KV cells per branch — incremented on
 * `decode_each` / `decode_scatter`, decremented on release by
 * `position - fork_head` (unique cells above the fork point), reset on
 * bulk ops like `retainOnly` and `drain`.
 *
 * Two thresholds partition `remaining` into three zones:
 *
 * ```
 * ┌──────────────────────────────────────────────────────┐
 * │                    nCtx                              │
 * │  ┌──────────┬───────────────────┬──────────────────┐ │
 * │  │cellsUsed │    headroom > 0   │    softLimit     │ │
 * │  │ (in use) │   (new work OK)   │    (reserved)    │ │
 * │  └──────────┴───────────────────┴──────────────────┘ │
 * │              ◄── remaining ──►  │                    │
 * │                                 │                    │
 * │  headroom = remaining - softLimit                    │
 * │  critical = remaining < hardLimit                    │
 * └──────────────────────────────────────────────────────┘
 * ```
 *
 * - **headroom > 0** — room for new work (tool results, generation)
 * - **headroom ≤ 0** — over budget. Admission defers tool results, the
 *   policy hard-cuts non-terminal tool calls. Terminal tools still pass.
 * - **critical** — remaining below hardLimit. Agents are dropped before they
 *   sample again, to prevent llama_decode crashes.
 *
 * @category Agents
 */
export class ContextPressure {
  /** Default softLimit: 1024 tokens reserved for downstream work */
  static readonly DEFAULT_SOFT_LIMIT = 1024;
  /**
   * Default hardLimit: 512 tokens — matches llama.cpp's default `n_batch`.
   * The pool validates at startup that `hardLimit >= nBatch`; the default
   * is sized to satisfy the invariant for the default llama.cpp context.
   * Recovery fits within the `hardLimit` reserve.
   */
  static readonly DEFAULT_HARD_LIMIT = 512;
  /**
   * Assumed `nBatch` when the native binding doesn't expose it.
   * Pool startup validates `pressureThresholds.hardLimit >= this`.
   */
  static readonly ASSUMED_N_BATCH = 512;

  /** Total KV cache capacity, in CELLS. 0 when no context limit.
   *
   *  Not positions — the two diverge on the embedding rail. Under M-RoPE an
   *  image occupies far more cells than it advances position (measured on
   *  Qwen3.5: 564 cells for 32 positions, ~18x), so budgeting from a branch's
   *  position would under-count an image by that factor. Every number on this
   *  class is cells, and `cellsUsed` is what the cache actually reports. */
  readonly nCtx: number;
  /** KV cells currently in use (monotonic within a pool run). */
  readonly cellsUsed: number;
  /**
   * KV slots remaining (`nCtx - cellsUsed`).
   * Infinity when nCtx ≤ 0 (no context limit).
   */
  readonly remaining: number;
  /** Remaining KV floor — tokens reserved for downstream work */
  readonly softLimit: number;
  /** Crash-prevention floor — agents killed when remaining drops below */
  readonly hardLimit: number;

  /** Sample the store now (`ctx`), or freeze a reading that was already taken. */
  constructor(source: SessionContext | KvReading, opts?: PressureThresholds) {
    const p = typeof (source as SessionContext)._storeKvPressure === 'function'
      ? (source as SessionContext)._storeKvPressure()
      : (source as KvReading);
    this.nCtx = p.nCtx;
    this.cellsUsed = p.cellsUsed;
    this.remaining = p.nCtx <= 0 ? Infinity : p.remaining;
    this.softLimit = opts?.softLimit ?? ContextPressure.DEFAULT_SOFT_LIMIT;
    this.hardLimit = opts?.hardLimit ?? ContextPressure.DEFAULT_HARD_LIMIT;
  }

  /**
   * The snapshot after `cells` more cells are spent (negative = freed). The
   * scheduler derives the post-admission value from its own ledger instead of
   * reading the store again mid-decision; the thresholds ride along.
   */
  minus(cells: number): ContextPressure {
    return new ContextPressure(
      { nCtx: this.nCtx, cellsUsed: this.cellsUsed + cells, remaining: this.nCtx - (this.cellsUsed + cells) },
      { softLimit: this.softLimit, hardLimit: this.hardLimit },
    );
  }

  /**
   * Tokens available for new work: `remaining - softLimit`.
   * Positive means room to accept tool results or continue generating.
   * Negative means over budget — admission defers, the policy hard-cuts.
   */
  get headroom(): number { return this.remaining - this.softLimit; }

  /** `remaining < hardLimit` — the agent must not sample again. */
  get critical(): boolean { return this.remaining < this.hardLimit; }

  /** Can `tokenCount` tokens fit while staying above softLimit? */
  canFit(tokenCount: number): boolean { return tokenCount <= this.headroom; }

  /**
   * KV available as 0–100 integer. Single source of truth for the
   * percentage shown to agents (`contextAvailablePercent`), recorded
   * on tool history (`contextAfterPercent`), and used by
   * `policy.shouldExplore()`.
   */
  get percentAvailable(): number {
    return this.nCtx > 0
      ? Math.max(0, Math.round((this.remaining / this.nCtx) * 100))
      : 100;
  }
}

/** An unlimited context reads `remaining`/`headroom` as Infinity, which JSON
 *  cannot carry — the trace declares those fields nullable. */
export function finiteOrNull(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

/** The four-field pressure record several trace events carry. */
export function pressureRecord(p: ContextPressure): {
  remaining: number | null; cellsUsed: number; nCtx: number; headroom: number | null;
} {
  return {
    remaining: finiteOrNull(p.remaining), cellsUsed: p.cellsUsed,
    nCtx: p.nCtx, headroom: finiteOrNull(p.headroom),
  };
}
