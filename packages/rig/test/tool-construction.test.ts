/**
 * Tests for rig-resident tool construction.
 *
 * Tools are plain synchronous classes constructed with `new` (no factory
 * wrappers — those would be `new` synonyms). `reportTool` is a shared
 * stateless singleton used as the conventional terminal. Deep execution
 * (`DelegateTool` spawns a pool; `PlanTool` generates against a Session)
 * is model-dependent and covered by the §10.3 routing-equivalence gate,
 * not here — these tests lock construction + identity + schema shape.
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { ReportTool } from '../src/tools/report';
import { DelegateTool } from '../src/tools/delegate';
import { PlanTool } from '../src/tools/plan';
import { reportTool } from '../src/tools';

describe('reportTool singleton', () => {
  it('is a ReportTool named "report" with a required result param', () => {
    expect(reportTool).toBeInstanceOf(ReportTool);
    expect(reportTool.name).toBe('report');
    expect(reportTool.parameters.required).toEqual(['result']);
    expect(reportTool.parameters.properties).toHaveProperty('result');
  });

  it('is a shared instance (reused across pools)', async () => {
    const again = (await import('../src/tools')).reportTool;
    expect(again).toBe(reportTool);
  });
});

describe('new ReportTool(opts)', () => {
  it('honors description overrides for the custom case', () => {
    const tool = new ReportTool({
      description: 'custom report desc',
      resultDescription: 'custom result desc',
    });
    expect(tool.description).toBe('custom report desc');
    const props = tool.parameters.properties as { result: { description: string } };
    expect(props.result.description).toBe('custom result desc');
  });

  it('merges extraProperties + extraRequired into the schema (the citation seam)', () => {
    const sources = {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, url: { type: 'string' } },
        required: ['title', 'url'],
      },
    };
    const tool = new ReportTool({ extraProperties: { sources }, extraRequired: ['sources'] });
    const props = tool.parameters.properties as Record<string, unknown>;
    // `result` is preserved; `sources` is merged in alongside it.
    expect(props).toHaveProperty('result');
    expect(props.sources).toEqual(sources);
    // Both are required — `result` first, extras appended.
    expect(tool.parameters.required).toEqual(['result', 'sources']);
  });

  it('leaves the schema at the default {result} shape when no extras are passed', () => {
    const tool = new ReportTool();
    expect(Object.keys(tool.parameters.properties as object)).toEqual(['result']);
    expect(tool.parameters.required).toEqual(['result']);
  });

  it('reserves `result`: extraProperties cannot override the built-in result schema', () => {
    const tool = new ReportTool({
      resultDescription: 'canonical result desc',
      extraProperties: {
        result: { type: 'number', description: 'bogus override' },
        sources: { type: 'array' },
      },
    });
    const props = tool.parameters.properties as {
      result: { type: string; description: string };
    };
    // result stays the canonical string schema, not the caller's override…
    expect(props.result.type).toBe('string');
    expect(props.result.description).toBe('canonical result desc');
    // …and remains first, with the non-reserved extra merged after it.
    expect(Object.keys(tool.parameters.properties as object)).toEqual(['result', 'sources']);
  });

  it('de-duplicates `required` (result first) when extraRequired repeats or includes result', () => {
    const tool = new ReportTool({
      extraProperties: { sources: { type: 'array' } },
      extraRequired: ['result', 'sources', 'sources'],
    });
    expect(tool.parameters.required).toEqual(['result', 'sources']);
  });

  it('throws when extraRequired names a property missing from extraProperties', () => {
    // typo / extraRequired without the matching extraProperties → invalid schema
    expect(() => new ReportTool({ extraRequired: ['sources'] })).toThrow(/not defined in extraProperties/);
    expect(
      () => new ReportTool({ extraProperties: { sources: { type: 'array' } }, extraRequired: ['sauces'] }),
    ).toThrow(/"sauces"/);
  });
});

describe('new DelegateTool(opts)', () => {
  it('defaults to name "delegate" with a tasks schema', () => {
    const tool = new DelegateTool({ poolOpts: {}, systemPrompt: 'sys' });
    expect(tool.name).toBe('delegate');
    expect(tool.parameters.required).toEqual(['tasks']);
  });

  it('honors a custom name', () => {
    const tool = new DelegateTool({ name: 'fanout', poolOpts: {}, systemPrompt: 'sys' });
    expect(tool.name).toBe('fanout');
  });
});

describe('new PlanTool(opts)', () => {
  const fakeSession = {} as never;

  it('is named "plan" with a required query param', () => {
    const tool = new PlanTool({
      prompt: { system: 's', user: 'u' },
      session: fakeSession,
      maxTasks: 5,
    });
    expect(tool.name).toBe('plan');
    expect(tool.parameters.required).toEqual(['query']);
  });

  it('accepts availableApps without throwing (grammar-constrained task.app)', () => {
    const apps = [
      { manifest: { protocol: { name: 'web_research' } } },
      { manifest: { protocol: { name: 'corpus_search' } } },
    ] as never[];
    const tool = new PlanTool({
      prompt: { system: 's', user: 'u' },
      session: fakeSession,
      maxTasks: 5,
      availableApps: apps,
    });
    expect(tool).toBeInstanceOf(PlanTool);
  });
});
