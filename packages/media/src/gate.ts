/**
 * @file The permit gate — the process-wide bound on decoded content in memory.
 *
 * Each concurrent normalization holds a fully decoded bitmap, and a document
 * ingest holds a page bitmap and a codec heap, so N simultaneous admissions
 * cost N such allocations however small the encoded bytes were. A served host
 * takes uploads from anyone who can reach it. The bound therefore belongs to
 * the PROCESS, not the request, and there is ONE gate: images and documents
 * take permits from the same pool, so together they never exceed it.
 *
 * Pure Node, no `sharp`: safe for any module behind `./node` to import.
 */

/**
 * How many admissions may hold decoded content at once, process-wide.
 *
 * @category Media
 */
export const MAX_CONCURRENT_NORMALIZATIONS = 4;

/**
 * How long a caller may WAIT for a permit before the host refuses it.
 *
 * A queue with no deadline turns a burst into a pile of held request bodies
 * that never drains; a caller that has waited this long is told so and can
 * retry, and the bytes it held are released.
 *
 * @category Media
 */
export const PERMIT_WAIT_TIMEOUT_MS = 60_000;

/**
 * How many callers may wait for a permit. Past this depth the answer is an
 * immediate busy, so memory is bounded by (permits + depth) admissions and
 * nothing more.
 *
 * @category Media
 */
export const MAX_QUEUED_NORMALIZATIONS = MAX_CONCURRENT_NORMALIZATIONS * 4;

/** The shape a caller can recognise without knowing this module. Matches what
 *  `fetch` throws on abort, because that is what callers already handle. */
export function abortError(label: string): Error {
  const e = new Error(`${label}: aborted`);
  e.name = 'AbortError';
  return e;
}

/** What {@link createGate} returns: one method, one permit per successful call. */
export interface Gate {
  /**
   * Take one permit; resolve to its release.
   *
   * `signal` is how a caller that has GIVEN UP stops occupying the queue —
   * an abandoned request holding a slot is a slot a live request cannot have.
   * Callers inside an Effection scope get this for free: the scope's own
   * signal aborts on halt. The signal covers the WAIT and the moment before
   * work starts; work already running is bounded by its own timeout.
   *
   * Release is idempotent: a double release would MANUFACTURE a permit, the
   * same bug as leaking one with the sign flipped.
   *
   * @throws `AbortError` when the signal is or becomes aborted before the
   *         permit is used; an error with `code: 'EBUSY'` when the queue is
   *         full; an error naming the wait when it outlasts `waitMs`.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
}

/**
 * Build a gate. The shared, process-wide instance is {@link gate}; a separate
 * one exists only for tests, which need small numbers.
 *
 * @category Media
 */
export function createGate(opts: { label: string; permits: number; maxQueued: number; waitMs: number }): Gate {
  const { label, maxQueued, waitMs } = opts;
  let permits = opts.permits;
  const waiting: { grant: () => void; refuse: (e: Error) => void }[] = [];

  const busy = (): Error => {
    const e = new Error(`${label}: ${opts.permits} in flight and ${maxQueued} queued — busy, retry later.`);
    (e as Error & { code: string }).code = 'EBUSY';
    return e;
  };
  const hand = (): void => {
    const next = waiting.shift();
    if (next) next.grant(); else permits++;
  };

  return {
    async acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) throw abortError(label);

      if (permits > 0) {
        permits--;
      } else {
        if (waiting.length >= maxQueued) throw busy();
        await new Promise<void>((resolve, reject) => {
          const leave = (): void => {
            const at = waiting.indexOf(entry);
            if (at >= 0) waiting.splice(at, 1);
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          };
          const onAbort = (): void => { leave(); reject(abortError(label)); };
          const entry = {
            grant: () => { leave(); resolve(); },
            refuse: (e: Error) => { leave(); reject(e); },
          };
          const timer = setTimeout(() => entry.refuse(new Error(
            `${label}: waited ${waitMs}ms for one of ${opts.permits} slots and none came free.`,
          )), waitMs);
          // Do not hold the process open on account of a queued caller.
          timer.unref?.();
          signal?.addEventListener('abort', onAbort, { once: true });
          waiting.push(entry);
        });
      }

      // Granted, but the caller may have given up while it waited. Handing the
      // permit straight to the next in line beats spending it on work nobody
      // is waiting for.
      if (signal?.aborted) {
        hand();
        throw abortError(label);
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        hand();
      };
    },
  };
}

/**
 * The one process-wide gate. Module-level on purpose: the resource it protects
 * is host memory, shared by every session and every request, so a per-call or
 * per-store limiter would not bound anything.
 *
 * @category Media
 */
export const gate: Gate = createGate({
  label: 'normalizeImage',
  permits: MAX_CONCURRENT_NORMALIZATIONS,
  maxQueued: MAX_QUEUED_NORMALIZATIONS,
  waitMs: PERMIT_WAIT_TIMEOUT_MS,
});
