import type { Operation } from "effection";
import { call } from "effection";
import { Tool } from "@lloyal-labs/lloyal-agents";
import type { JsonSchema } from "@lloyal-labs/lloyal-agents";

/**
 * __NAME___fetch — fetch the full detail for a single __NAME__ item by id.
 *
 * Scaffolded with Wikipedia's REST page-summary endpoint so the app runs
 * out of the box. Replace `execute` with your real backend; keep the
 * schema + return shape so consumers stay compatible.
 */
export class __NAME_PASCAL__FetchTool extends Tool<{ id: string }> {
  readonly name = "__NAME___fetch";
  readonly protected = false;
  readonly description =
    "EDIT THIS: short, model-facing description of what __NAME___fetch does and when an agent should call it. Typically: 'Fetch full detail for a single item by id, as returned by __NAME___search.'";
  readonly parameters: JsonSchema = {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Item identifier as returned by __NAME___search (typically the result's `id` or `title`).",
      },
    },
    required: ["id"],
  };

  *execute(args: { id: string }): Operation<unknown> {
    const id = args.id?.trim();
    if (!id) return { error: "id must not be empty" };

    // STUB: Replace this Wikipedia REST call with a request to your real
    // __NAME__ backend. The return shape is what the agent sees.
    const path = encodeURIComponent(id.replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${path}`;

    try {
      const payload = yield* call(async () => {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return res.json();
      });
      if (payload === null) {
        return { id, error: "Item not found." };
      }
      const p = payload as Record<string, unknown>;
      return {
        id,
        title: typeof p.title === "string" ? p.title : id,
        description: typeof p.description === "string" ? p.description : undefined,
        content: typeof p.extract === "string" ? p.extract : "",
        url: ((p.content_urls ?? {}) as { desktop?: { page?: string } }).desktop?.page,
      };
    } catch (err) {
      return {
        error: `__NAME___fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
