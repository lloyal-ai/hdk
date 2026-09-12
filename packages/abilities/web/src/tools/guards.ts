import type { ToolGuard } from "@lloyal-labs/lloyal-agents";

/**
 * The web ability's gates, declared beside the tools that own them.
 *
 * Each gate refuses a call the agent already made: a URL already attended is
 * not fetched again, a query already attended is not searched again. Whose
 * attended calls count is the harness's decision, not this ability's — a
 * gate reads `attended()` in the scope the harness chose (the agent's own
 * lineage unless the harness re-scoped the gate to the whole cohort), so the
 * same declaration serves a pool whose siblings share a synthesis and a pool
 * whose branches must not see each other's evidence.
 *
 * @category Rig
 */

/**
 * A string argument trimmed the way both web tools trim before they act, or
 * `undefined` when absent or not a string. The gates normalise the current
 * arguments and the attended ones through the same function, so a
 * whitespace-only variant is one resource; the tools use it too, so a gate
 * never normalises less than the tool it guards.
 */
export function trimmed(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}

/** `fetch_page`: a URL already attended is not fetched again. */
export const urlDedup: ToolGuard = {
  name: "url_dedup",
  reject: ({ args, attended }) => {
    const url = trimmed(args.url);
    return !!url && attended().some((a) => trimmed(a.url) === url);
  },
  message: "This URL was already attempted in this run. Try a different source.",
};

/** `web_search`: a query already attended is not searched again; case folded, so a capitalisation-only variant is one query. */
export const queryDedup: ToolGuard = {
  name: "query_dedup",
  reject: ({ args, attended }) => {
    const query = trimmed(args.query)?.toLowerCase();
    return !!query && attended().some((a) => trimmed(a.query)?.toLowerCase() === query);
  },
  message: "This search was already attempted in this run. Refine the query or report your findings.",
};
