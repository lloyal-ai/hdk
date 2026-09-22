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
 * A typed output is LOSSLESS: what the model wrote is what is captured and read
 * back, byte for byte — a program that contains the string `"<tool_call>"` is
 * still that program. Only a capture that knows which of its strings is prose
 * repairs it (`citedReport`: the findings lose a trailing unclosed call before
 * the citation trailer is appended, or the trailer would bury it). The
 * framework's own strip applies only to what the framework captures itself.
 *
 * @category Rig
 */
import type { Operation } from 'effection';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { Tool, stripDanglingToolCall } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolLifecycleHooks } from '@lloyal-labs/lloyal-agents';
import { weaveSourcesIntoResult } from './weave-sources';

/** A typed output: the terminal tool, and the reading of what it captured. */
export interface Output<T> {
  readonly tool: Tool;
  /** The value an outcome carries, or `null` when there is none or it is not the typed value. */
  read(outcome: { result: string | null }): T | null;
}

export interface OutputOptions<T> {
  /** What the model is told the tool is for. @default `Submit your <name>.` */
  description?: string;
  /** Make the result text from the validated value (a report's citation weave). The output then reads as text.
   *  The third argument is the template's reasoning close (empty when it does not think) — a capture that
   *  repairs prose needs it, because the framework's own repair cannot see a fragment once text is appended
   *  after it. */
  capture?: (value: T, raw: string, thinkingEndTag: string) => string;
}

class OutputTool<S extends ZodType> extends Tool<Record<string, unknown>> {
  readonly parameters: JsonSchema;
  readonly hooks: ToolLifecycleHooks;
  constructor(
    readonly name: string,
    readonly description: string,
    schema: S,
    capture?: (value: z.output<S>, raw: string, thinkingEndTag: string) => string,
  ) {
    super();
    // The schema is the grammar: what the model can emit is what `read` accepts.
    const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as JsonSchema & { $schema?: string };
    this.parameters = parameters;
    this.hooks = {
      onReturn: ({ agent, args, raw }) => {
        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          return {
            type: 'reject',
            message: `Your ${name} call did not match its schema — ${issues}. Call ${name} again with every field as specified.`,
          };
        }
        // A capture-less output's result is the RAW arguments, so `read` validates the model's own bytes once —
        // a schema's transforms run one time, at read, never twice.
        return { type: 'accept', result: capture ? capture(parsed.data, raw, agent.fmt.thinkingEndTag) : raw };
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
  opts: { description?: string; capture: (value: z.output<S>, raw: string, thinkingEndTag: string) => string },
): Output<string>;
export function defineOutput<S extends ZodType>(
  name: string,
  schema: S,
  opts?: { description?: string },
): Output<z.output<S>> & {
  /** The value's shape as JSON Schema — the tool's parameters. An agent can be constrained to generate the value
   *  alone (`agentPool({ schema })`, `useAgent({ schema })`), and `read` decodes an accepted answer as it decodes
   *  a call. A captured output has none: its result is the capture's text, never the value. */
  readonly schema: JsonSchema;
};
export function defineOutput<S extends ZodType>(
  name: string,
  schema: S,
  opts: OutputOptions<z.output<S>> = {},
): Output<unknown> & { readonly schema?: JsonSchema } {
  const tool = new OutputTool(name, opts.description ?? `Submit your ${name}.`, schema, opts.capture);
  if (opts.capture) {
    // Absence is `null` here as it is everywhere else: `''` is text the capture
    // can legitimately make, so it cannot also stand for "no outcome".
    return { tool, read: (o) => o.result };
  }
  return {
    tool,
    schema: tool.parameters,
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
    // The findings are prose the model may have cut short: a trailing unclosed call goes BEFORE the trailer
    // is appended, where the framework's end-anchored strip could no longer see it. A reaped agent restarts
    // its envelope inside the argument it was writing, so the close that opens that restart goes with it —
    // which needs the template's own tag, since this capture, not the framework, is the one repairing here.
    capture: ({ result, sources }, _raw, thinkingEndTag) =>
      weaveSourcesIntoResult(stripDanglingToolCall(result, thinkingEndTag), sources),
  },
);
