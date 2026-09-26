/**
 * Which HTTP statuses are weather the pool waits out, and which are answers the
 * model reads. The distinction is the whole point: a retried call costs the
 * agent no turn and no context, while an error result costs both and tells it
 * nothing it can act on.
 */
import { describe, it, expect } from "vitest";
import { ToolRetryError } from "@lloyal-labs/lloyal-agents";
import { transient } from "../src/tools/http";

/** A response as `transient` reads it: a status and the one header it consults. */
const res = (status: number, retryAfter?: string) => ({
  status,
  headers: { get: (name: string) => (name === "Retry-After" ? (retryAfter ?? null) : null) },
});

describe("transient", () => {
  it("makes rate limiting and unavailability the pool's wait", () => {
    for (const status of [429, 503]) {
      const weather = transient(res(status));
      expect(weather).toBeInstanceOf(ToolRetryError);
      expect(weather!.message).toContain(String(status));
    }
  });

  it("honours Retry-After, in seconds, as milliseconds", () => {
    expect(transient(res(429, "30"))!.retryAfterMs).toBe(30_000);
  });

  it("falls back to a second when the header is absent, unparseable, or not positive", () => {
    for (const header of [undefined, "", "soon", "Wed, 21 Oct 2026 07:28:00 GMT", "0", "-5"]) {
      expect(transient(res(503, header))!.retryAfterMs).toBe(1000);
    }
  });

  it("leaves every other status an ordinary failure — a 404 is an answer about the article", () => {
    for (const status of [200, 400, 403, 404, 418, 500, 502]) {
      expect(transient(res(status))).toBeUndefined();
    }
  });
});
