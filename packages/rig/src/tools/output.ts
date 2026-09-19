/**
 * `defineOutput(name, schema)`: the terminal tool of a typed result. The schema
 * is the tool's grammar, so the model can only emit the shape; the capture is
 * the tool's own (`onReturn`): a call that matches is accepted with its raw
 * arguments as the agent's result, a call that misses the shape asks for one
 * rejection, and `read(outcome)` gives the typed value back — or `null`, never a
 * guess. With a `capture`, the result is the text the capture makes of the
 * value, and `read` returns that text. A pool that dispatches this tool
 * instead of ending on it has misplaced it, and is told so.
 *
 * `citedReport` is the research output on the same primitive: the `report`
 * terminal whose grammar-forced `sources` are woven into the findings at capture.
 *
 * The text the model put in the call is cleaned HERE, once, before it is
 * validated: a string that ends in an unclosed `<tool_call>` fragment loses the
 * fragment, and the schema judges what will be captured. A capture that appends to the text (the citation weave's `Sources:`
 * list) would otherwise bury the fragment mid-result, and a capture-less
 * output's JSON ends in `"}`, so the framework's own strip — which runs after
 * the return, anchored to the end — can see neither.
 *
 * @category Rig
 */
import type { Operation } from 'effection';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { Tool, stripDanglingToolCall } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolLifecycleHooks } from '@lloyal-labs/lloyal-agents';
import { weaveSourcesIntoResult } from './weave-sources';

/** The validated value with every string the model wrote cleaned of a trailing unclosed tool call. A string
 *  without one is returned as it is — the strip's own trailing trim would otherwise alter typed data. */
function cleaned<T>(value: T): T {
  if (typeof value === 'string') return (value.includes('<tool_call>') ? stripDanglingToolCall(value) : value) as T;
  if (Array.isArray(value)) return value.map(cleaned) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleaned(v)])) as T;
  }
  return value;
}

/** A typed output: the terminal tool, and the reading of what it captured. */
export interface Output<T> {
  readonly tool: Tool;
  /** The value an outcome carries, or `null` when there is none or it is not the typed value. */
  read(outcome: { result: string | null }): T | null;
}

export interface OutputOptions<T> {
  /** What the model is told the tool is for. @default `Submit your <name>.` */
  description?: string;
  /** Make the result text from the validated value (a report's citation weave). The output then reads as text. */
  capture?: (value: T, raw: string) => string;
}

class OutputTool<S extends ZodType> extends Tool<Record<string, unknown>> {
  readonly parameters: JsonSchema;
  readonly hooks: ToolLifecycleHooks;
  constructor(
    readonly name: string,
    readonly description: string,
    schema: S,
    capture?: (value: z.output<S>, raw: string) => string,
  ) {
    super();
    // The schema is the grammar: what the model can emit is what `read` accepts.
    const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as JsonSchema & { $schema?: string };
    this.parameters = parameters;
    this.hooks = {
      onReturn: ({ args, raw }) => {
        // Cleaned BEFORE validation, so what is validated is what is captured: a string the strip shortens
        // must still satisfy its own schema, or the return is refused now rather than read back as null later.
        const parsed = schema.safeParse(cleaned(args));
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          return {
            type: 'reject',
            message: `Your ${name} call did not match its schema — ${issues}. Call ${name} again with every field as specified.`,
          };
        }
        // A capture reads the clean value; a capture-less output's result is the clean value serialized — a
        // fragment inside a JSON string would otherwise survive the applier's end-anchored strip, which sees
        // only the closing `"}`.
        return { type: 'accept', result: capture ? capture(parsed.data, raw) : JSON.stringify(parsed.data) };
      },
    };
  }
  *execute(): Operation<unknown> {
    throw new Error(`${this.name} ends the agent's turn: pass it as the pool's terminal, not among its tools`);
  }
}

// The capture overload comes first: an object literal's callback is contextually typed
// against the first overload tried, and a capture-less first signature would leave it untyped.
export function defineOutput<S extends ZodType>(
  name: string,
  schema: S,
  opts: { description?: string; capture: (value: z.output<S>, raw: string) => string },
): Output<string>;
export function defineOutput<S extends ZodType>(name: string, schema: S, opts?: { description?: string }): Output<z.output<S>>;
export function defineOutput<S extends ZodType>(name: string, schema: S, opts: OutputOptions<z.output<S>> = {}): Output<unknown> {
  const tool = new OutputTool(name, opts.description ?? `Submit your ${name}.`, schema, opts.capture);
  if (opts.capture) {
    // Absence is `null` here as it is everywhere else: `''` is text the capture
    // can legitimately make, so it cannot also stand for "no outcome".
    return { tool, read: (o) => o.result };
  }
  return {
    tool,
    read: (o) => {
      if (o.result === null) return null;
      let value: unknown;
      try {
        value = JSON.parse(o.result);
      } catch {
        return null;
      }
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  };
}

/**
 * The research output: the `report` terminal, its findings and the sources they
 * rest on, woven into inline citations at capture and read back as text.
 *
 * @category Rig
 */
export const citedReport: Output<string> = defineOutput(
  'report',
  z.object({
    result: z
      .string()
      .describe(
        'Detailed findings with direct quotes and data points. Cite each claim inline as [title](url) using the exact URL seen in tool results. Include what was found and what was not found.',
      ),
    sources: z
      .array(z.object({ title: z.string(), url: z.string() }))
      .describe('Every source you used: exact title and exact URL as seen in tool results. Empty array only if no URL sources exist.'),
  }),
  {
    description:
      'Submit your final research findings with specific evidence, direct quotes, and data points. Cite each claim inline as [title](url) using the exact URL seen in tool results. Fill the sources field with the structured list of every source you used. State what you found AND what you checked but could not find. Do not summarize — preserve detail.',
    capture: ({ result, sources }) => weaveSourcesIntoResult(result, sources),
  },
);
