/**
 * The planner's routing key — the one token in the framework the model both
 * READS (from the plan prompt) and WRITES (into grammar-constrained JSON).
 *
 * ## Why this file exists
 *
 * `TASK_ROUTING_KEY` is a constant rather than a literal because its value is
 * an open question: the grammar constrains the property to an enum of
 * `manifest.protocol.name` values and the harness looks the result up in a
 * protocol-keyed map, so the key has never named what it holds. Comparing
 * candidates (`app` / `ability` / `protocol`) is an eval question, and the
 * eval varies this one constant.
 *
 * That only works if nothing else hard-codes the key. Three places have to
 * agree, and NONE of them fail loudly when they disagree:
 *
 * 1. the schema (the decode grammar) — emits the property
 * 2. the parse — reads it back off the model's JSON
 * 3. the plan prompt — tells the model which property to fill
 *
 * Desync 1 and 2 and every task silently loses its routing: `ability` comes
 * back undefined, `appForTask` falls through to the primary, and the pipeline
 * runs happily with every task pointed at one source. No error, no warning —
 * just worse research. That is the failure this file is here to prevent.
 *
 * The prompt (3) lives in each harness's own `plan.eta`, outside this package,
 * which is exactly why `PlanTool` passes the key to the template as
 * `routingKey` instead of letting the prose name it independently.
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { buildPlanSchema } from '../src/tools/plan';
import { TASK_ROUTING_KEY } from '../src/protocol';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';

const PROTOCOLS = ['web_research', 'corpus_research'];

/** The per-task object inside the plan schema. */
function taskItems(schema: JsonSchema): { properties: Record<string, JsonSchema>; required: string[] } {
  const props = schema.properties as Record<string, JsonSchema>;
  const tasks = props.tasks as JsonSchema & { items: JsonSchema };
  const items = tasks.items as JsonSchema & { properties: Record<string, JsonSchema>; required: string[] };
  return { properties: items.properties, required: items.required };
}

describe('TASK_ROUTING_KEY', () => {
  it('is a non-empty identifier safe to use as a JSON property', () => {
    expect(typeof TASK_ROUTING_KEY).toBe('string');
    expect(TASK_ROUTING_KEY).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
  });
});

describe('buildPlanSchema — the decode grammar', () => {
  it('keys the routing property by TASK_ROUTING_KEY, not a literal', () => {
    const { properties } = taskItems(buildPlanSchema(PROTOCOLS, 5));
    expect(Object.keys(properties).sort()).toEqual(['description', TASK_ROUTING_KEY].sort());
  });

  it('makes routing REQUIRED so the model cannot omit a destination', () => {
    const { required } = taskItems(buildPlanSchema(PROTOCOLS, 5));
    expect(required).toContain(TASK_ROUTING_KEY);
    expect(required).toContain('description');
  });

  it('constrains the value to the given protocol names', () => {
    const { properties } = taskItems(buildPlanSchema(PROTOCOLS, 5));
    expect(properties[TASK_ROUTING_KEY]).toEqual({ type: 'string', enum: PROTOCOLS });
  });

  it('copies the enum — a later mutation of the caller’s array cannot reach the grammar', () => {
    const names = [...PROTOCOLS];
    const { properties } = taskItems(buildPlanSchema(names, 5));
    names.push('injected_protocol');
    const e = (properties[TASK_ROUTING_KEY] as unknown as { enum: string[] }).enum;
    expect(e).not.toContain('injected_protocol');
  });

  it('drops the routing property entirely with no abilities', () => {
    const { properties, required } = taskItems(buildPlanSchema([], 5));
    expect(Object.keys(properties)).toEqual(['description']);
    expect(required).toEqual(['description']);
  });

  it('caps the task array at maxTasks', () => {
    const props = buildPlanSchema(PROTOCOLS, 3).properties as Record<string, JsonSchema>;
    expect((props.tasks as unknown as { maxItems: number }).maxItems).toBe(3);
  });
});

describe('schema ↔ parse agreement', () => {
  // The regression this whole file targets: the parse reads a DIFFERENT key
  // than the schema emits. Simulated end to end — build the grammar, emit the
  // JSON a compliant model would produce under it, and read it back the way
  // PlanTool does.
  it('round-trips a routing decision through the same key', () => {
    const { properties } = taskItems(buildPlanSchema(PROTOCOLS, 5));
    const emittedKey = Object.keys(properties).find((k) => k !== 'description')!;

    const modelOutput = JSON.stringify({
      intent: 'research',
      tasks: [{ description: 'find pricing', [emittedKey]: 'web_research' }],
    });

    const parsed = JSON.parse(modelOutput) as {
      tasks: (Record<string, unknown> & { description?: string })[];
    };
    const routed = parsed.tasks[0][TASK_ROUTING_KEY];

    expect(routed).toBe('web_research');
  });

  it('a task missing the key yields an unrouted task rather than a crash', () => {
    const parsed = JSON.parse('{"tasks":[{"description":"no route"}]}') as {
      tasks: (Record<string, unknown> & { description?: string })[];
    };
    const routed = parsed.tasks[0][TASK_ROUTING_KEY];
    expect(routed).toBeUndefined();
    expect(typeof parsed.tasks[0].description).toBe('string');
  });
});
