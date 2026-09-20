import type { ToolGuard } from "@lloyal-labs/lloyal-agents";

/**
 * The Wikipedia ability's gates, declared beside the tools that own them.
 *
 * Each gate refuses a call the agent already made: a query already attended is
 * not searched again, an article already attended is not fetched again. Whose
 * attended calls count is the harness's decision, not this ability's — a gate
 * reads `attended()` in the scope the harness chose (the agent's own lineage
 * unless the harness re-scoped the gate to the whole cohort), so the same
 * declaration serves a pool whose siblings share a synthesis and a pool whose
 * branches must not see each other's evidence.
 */

/**
 * A string argument trimmed the way both tools trim before they act, or
 * `undefined` when absent or not a string.
 */
export function trimmed(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}

/**
 * An article title as Wikipedia addresses it: trimmed, with every run of
 * whitespace collapsed to the underscore the REST path uses. `wikipedia_fetch`
 * builds its URL through this same function, so "Alan  Turing" and
 * "Alan Turing" are one article to the gate exactly as they are to the fetch —
 * a gate never normalises less than the tool it guards.
 *
 * Case is kept: MediaWiki titles are case-sensitive past the first letter, and
 * the tool's own description tells the model so.
 */
export function articleKey(v: unknown): string | undefined {
  const title = trimmed(v);
  return title ? title.replace(/\s+/g, "_") : title;
}

/** `wikipedia_search`: a query already attended is not searched again; case folded, so a capitalisation-only variant is one query. */
export const queryDedup: ToolGuard = {
  name: "query_dedup",
  reject: ({ args, attended }) => {
    const query = trimmed(args.query)?.toLowerCase();
    return !!query && attended().some((a) => trimmed(a.query)?.toLowerCase() === query);
  },
  message: "This search was already attempted in this run. Refine the query.",
};

/** `wikipedia_fetch`: an article already attended is not fetched again. */
export const titleDedup: ToolGuard = {
  name: "title_dedup",
  reject: ({ args, attended }) => {
    const title = articleKey(args.title);
    return !!title && attended().some((a) => articleKey(a.title) === title);
  },
  message: "This article was already fetched in this run. Try a different title.",
};
