import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';

/**
 * Options for {@link ReportTool}.
 *
 * @category Rig
 */
export interface ReportToolOpts {
  /** Override the tool description shown in the agent's tool schema. */
  description?: string;
  /** Override the `result` parameter description. */
  resultDescription?: string;
  /**
   * Extra JSON-schema properties merged into `parameters.properties` alongside
   * `result`. Their shape is grammar-forced when the model emits the report
   * call, so a harness can require structured fields (e.g. a
   * `sources: [{title, url}]` array for inline citations) WITHOUT re-declaring a
   * parallel `report` tool. The pool still captures only the `result` string;
   * a policy override reads the sibling fields off the same tool call.
   *
   * `result` is RESERVED and cannot be overridden here — the pool's terminal
   * capture reads `.result`, so it is always the canonical string schema. A
   * `result` key in `extraProperties` is ignored (use `resultDescription`).
   *
   * @example
   * new ReportTool({
   *   extraProperties: {
   *     sources: {
   *       type: 'array',
   *       items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] },
   *     },
   *   },
   *   extraRequired: ['sources'],
   * });
   */
  extraProperties?: Record<string, JsonSchema>;
  /**
   * Property names (from {@link extraProperties}) to mark `required` alongside
   * `result`. Every name must be defined in `extraProperties` (or be the reserved
   * `result`) — an unknown name throws, since a required-but-undefined property is
   * an invalid schema the grammar can't force. Note the grammar forces a required
   * field's PRESENCE and SHAPE, not its contents: a required array without
   * `minItems` still permits `[]`, and a bare `{ type: 'string' }` url permits any
   * string.
   */
  extraRequired?: string[];
}

/**
 * Terminal tool for submitting agent results.
 *
 * Used as the `terminalToolName` in agent pools — when an agent calls
 * this tool, the pool records the result string and marks the agent
 * as finished. The tool's `execute()` code-path is not reached; the
 * agent pool intercepts the call at the policy layer and extracts the
 * `result` argument as the agent's return value.
 *
 * **Schema extension.** The default schema is `{ result: string }`. Pass
 * {@link ReportToolOpts.extraProperties} / {@link ReportToolOpts.extraRequired}
 * to merge additional grammar-forced fields into `parameters` — the seam a
 * harness uses to force structured `sources` for inline citations instead of
 * shadowing this tool with a hand-synced copy.
 *
 * @category Rig
 */
export class ReportTool extends Tool<{ result: string }> {
  readonly name = 'report';
  readonly description: string;
  readonly parameters: JsonSchema;

  constructor(opts?: ReportToolOpts) {
    super();
    this.description = opts?.description ??
      'Submit your final research findings with specific evidence, direct quotes, data points, and source URLs from the pages you read. State what you found AND what you checked but could not find. Do not summarize — preserve detail.';
    // `result` is reserved: strip it from the extras so it can't be overridden
    // (the pool's terminal capture reads `.result`) and set it canonically as
    // the first property — the extension is strictly additive.
    const extra = { ...(opts?.extraProperties ?? {}) };
    delete extra.result;
    // Fail loud on a required name with no schema: `result` is always defined
    // (the base property); any other required name must have been supplied in
    // extraProperties, else the schema requires an untyped property the grammar
    // can't force — a caller typo, caught here rather than silently dropped.
    const extraRequired = opts?.extraRequired ?? [];
    for (const name of extraRequired) {
      if (name !== 'result' && !Object.prototype.hasOwnProperty.call(extra, name)) {
        throw new Error(
          `ReportTool: extraRequired references "${name}", which is not defined in extraProperties. ` +
            `Add it to extraProperties, or remove it from extraRequired.`,
        );
      }
    }
    this.parameters = {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: opts?.resultDescription ??
            'Detailed findings with direct quotes, data points, and source URLs. Include what was found and what was not found.',
        },
        ...extra,
      },
      // De-duplicate (Set preserves insertion order → `result` stays first), so a
      // caller repeating a name or passing `result` in extraRequired can't emit an
      // invalid `required` array.
      required: [...new Set(['result', ...extraRequired])],
    };
  }

  *execute(): Operation<unknown> { return {}; }
}
