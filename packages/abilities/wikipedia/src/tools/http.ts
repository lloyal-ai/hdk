import { ToolRetryError } from "@lloyal-labs/lloyal-agents";

/**
 * Wikipedia's transient weather, told to the pool rather than to the model.
 *
 * Rate limiting (429) and brief unavailability (503) are not facts an agent can
 * act on — spending a turn to read "try again later" costs context and teaches
 * the model nothing. Raising {@link ToolRetryError} instead makes the agent wait
 * at no cost to its turns and run the same call again, and only an outage that
 * outlives the retries becomes a result the model sees.
 *
 * Every other status stays an ordinary failure: a 404 is an answer about the
 * article, not weather.
 */
export function transient(res: { status: number; headers: { get(name: string): string | null } }):
  | ToolRetryError
  | undefined {
  if (res.status !== 429 && res.status !== 503) return undefined;
  // `Retry-After` in seconds when Wikipedia sends one; a second otherwise. The
  // HTTP-date form is deliberately not parsed — it would buy a rarely-sent
  // header the right to schedule our backoff.
  const after = Number(res.headers.get("Retry-After"));
  const ms = Number.isFinite(after) && after > 0 ? after * 1000 : 1000;
  return new ToolRetryError(`Wikipedia returned HTTP ${res.status}`, ms);
}
