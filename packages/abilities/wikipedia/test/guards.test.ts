/**
 * The Wikipedia ability's gates: what each refuses, normalised the way its tool
 * normalises, and that the tools declare them. Scope is not tested here — a
 * gate reads whatever `attended()` the pool hands it, and the pool's scoping is
 * the framework's (`hooks.test.ts` in agents).
 */
import { describe, it, expect } from "vitest";
import type { GuardInput } from "@lloyal-labs/lloyal-agents";
import { queryDedup, titleDedup, trimmed, articleKey } from "../src/tools/guards";
import { WikipediaSearchTool } from "../src/tools/search";
import { WikipediaFetchTool } from "../src/tools/fetch";
import { WikipediaSource } from "../src/source";

/** A call as a gate sees it, over the arguments this scope already attended. */
const seen = (
  tool: string,
  args: Record<string, unknown>,
  attended: Record<string, unknown>[],
): GuardInput => ({ tool, args, attended: () => attended });

describe("query_dedup — wikipedia_search's gate", () => {
  const q = { query: "alan turing" };

  it("refuses a query already attended", () => {
    expect(queryDedup.reject(seen("wikipedia_search", q, [q]))).toBe(true);
  });

  it("folds case and trims: '  Alan Turing ' is the same search, on either side", () => {
    expect(queryDedup.reject(seen("wikipedia_search", { query: "  Alan Turing " }, [q]))).toBe(true);
    expect(queryDedup.reject(seen("wikipedia_search", q, [{ query: "ALAN TURING" }]))).toBe(true);
  });

  it("admits a refined query", () => {
    expect(queryDedup.reject(seen("wikipedia_search", { query: "alan turing cryptanalysis" }, [q]))).toBe(false);
  });

  it("a call with no query, or a blank one, is not a duplicate of anything", () => {
    expect(queryDedup.reject(seen("wikipedia_search", {}, [q]))).toBe(false);
    expect(queryDedup.reject(seen("wikipedia_search", { query: " " }, [{ query: "" }]))).toBe(false);
  });

  it("is published under its name, with the message the model reads", () => {
    expect(queryDedup.name).toBe("query_dedup");
    expect(queryDedup.message).toBe("This search was already attempted in this run. Refine the query.");
  });
});

describe("title_dedup — wikipedia_fetch's gate", () => {
  const page = { title: "Alan Turing" };

  it("refuses an article already attended", () => {
    expect(titleDedup.reject(seen("wikipedia_fetch", page, [page]))).toBe(true);
  });

  it("normalises whitespace the way the fetch builds its path, on either side", () => {
    expect(titleDedup.reject(seen("wikipedia_fetch", { title: " Alan  Turing " }, [page]))).toBe(true);
    expect(titleDedup.reject(seen("wikipedia_fetch", page, [{ title: "Alan_Turing" }]))).toBe(true);
  });

  it("keeps case, because MediaWiki titles are case-sensitive and the tool says so", () => {
    expect(titleDedup.reject(seen("wikipedia_fetch", { title: "Alan turing" }, [page]))).toBe(false);
  });

  it("admits a different article", () => {
    expect(titleDedup.reject(seen("wikipedia_fetch", { title: "Bletchley Park" }, [page]))).toBe(false);
  });

  it("a call with no title, or a blank one, is not a duplicate of anything", () => {
    expect(titleDedup.reject(seen("wikipedia_fetch", {}, [page]))).toBe(false);
    expect(titleDedup.reject(seen("wikipedia_fetch", { title: "  " }, [{ title: "" }]))).toBe(false);
  });

  it("is published under its name, with the message the model reads", () => {
    expect(titleDedup.name).toBe("title_dedup");
    expect(titleDedup.message).toBe("This article was already fetched in this run. Try a different title.");
  });
});

describe("the tools declare their gates", () => {
  const userAgent = "test/1.0";

  it("wikipedia_search declares query_dedup; wikipedia_fetch declares title_dedup", () => {
    expect(new WikipediaSearchTool({ userAgent }).hooks.beforeDispatch).toEqual([queryDedup]);
    expect(new WikipediaFetchTool({ userAgent }).hooks.beforeDispatch).toEqual([titleDedup]);
  });

  it("the source's tools carry the declarations", () => {
    const tools = new WikipediaSource().tools;
    const gatesOf = (name: string) => tools.find((t) => t.name === name)!.hooks?.beforeDispatch;
    expect(gatesOf("wikipedia_search")).toEqual([queryDedup]);
    expect(gatesOf("wikipedia_fetch")).toEqual([titleDedup]);
  });

  it("both tools fan out: nothing they do touches the shared model", () => {
    for (const tool of new WikipediaSource().tools) expect(tool.fanout).toBe(true);
  });

  it("trimmed() and articleKey() are the normalisations the tools themselves apply", () => {
    expect(trimmed("  x ")).toBe("x");
    expect(trimmed(3)).toBeUndefined();
    expect(articleKey(" Alan  Turing ")).toBe("Alan_Turing");
    expect(articleKey("  ")).toBe("");
    expect(articleKey(undefined)).toBeUndefined();
  });
});
