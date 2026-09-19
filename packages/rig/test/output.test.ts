/**
 * `defineOutput(name, schema)`: a terminal tool whose grammar is the schema and
 * whose capture is the tool's own — validated at the return, rejected once when
 * the model missed the shape, read back typed through `read`. `citedReport` is
 * the research output on the same primitive: the grammar-forced `sources` woven
 * into the findings at capture. A tool the pool dispatches instead of ending on
 * refuses loud.
 */
import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { z } from 'zod';
import type { Agent } from '@lloyal-labs/lloyal-agents';
import { defineOutput, citedReport } from '../src/tools/output';
import { weaveSourcesIntoResult } from '../src/tools/weave-sources';

const columns = z.object({
  headquarters: z.string().describe('city, country'),
  sellsTo: z.enum(['businesses', 'consumers', 'both', 'unknown']),
  evidence: z.array(z.object({ field: z.string(), url: z.string() })),
}).strict();
const agent = {} as Agent;

describe('defineOutput', () => {
  it('is a terminal tool whose parameters are the schema, and whose execute refuses: it ends the turn', async () => {
    const submit = defineOutput('submit', columns, { description: 'Submit the row.' });
    expect(submit.tool.name).toBe('submit');
    expect(submit.tool.description).toBe('Submit the row.');
    const params = submit.tool.parameters as { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
    expect(params.type).toBe('object');
    expect(Object.keys(params.properties)).toEqual(['headquarters', 'sellsTo', 'evidence']);
    expect(params.required).toEqual(['headquarters', 'sellsTo', 'evidence']);
    expect((params.properties.headquarters as { description: string }).description).toBe('city, country');
    await expect(run(() => submit.tool.execute({}, {}))).rejects.toThrow(/ends the agent's turn.*terminal/);
  });

  it('accepts a call that matches the schema with the raw arguments as the result, and reads them back typed', () => {
    const submit = defineOutput('submit', columns);
    const row = { headquarters: 'Oslo, Norway', sellsTo: 'both', evidence: [{ field: 'headquarters', url: 'https://a.io' }] };
    const raw = JSON.stringify(row);
    const decision = submit.tool.hooks!.onReturn!({ agent, tool: 'submit', args: row, raw, result: raw });
    expect(decision).toEqual({ type: 'accept', result: raw });
    expect(submit.read({ result: raw })).toEqual(row);
  });

  it('a typed output is lossless: a program that contains the marker is still that program, whitespace and all', () => {
    const code = defineOutput('code', z.object({ source: z.string(), note: z.string() }));
    const row = { source: 'const opening = "<tool_call>";\nconsole.log(opening);\n', note: 'trailing  ' };
    const decision = code.tool.hooks!.onReturn!({ agent, tool: 'code', args: row, raw: JSON.stringify(row), result: '' });
    expect(decision).toEqual({ type: 'accept', result: JSON.stringify(row) });
    expect(code.read({ result: JSON.stringify(row) })).toEqual(row);
  });

  it("a schema's transform runs once, at read — the accepted result is the model's own bytes", () => {
    const bumped = defineOutput('n', z.object({ n: z.number().overwrite((n) => n + 1).max(4) }));
    const raw = JSON.stringify({ n: 3 });
    const decision = bumped.tool.hooks!.onReturn!({ agent, tool: 'n', args: { n: 3 }, raw, result: '' });
    expect(decision).toEqual({ type: 'accept', result: raw });
    expect(bumped.read({ result: raw })).toEqual({ n: 4 });
  });

  it('rejects a call that misses the shape, naming the field; read yields null for anything that is not the typed value', () => {
    const submit = defineOutput('submit', columns);
    const bad = { headquarters: 'Oslo', sellsTo: 'everyone', evidence: [] };
    const decision = submit.tool.hooks!.onReturn!({ agent, tool: 'submit', args: bad, raw: JSON.stringify(bad), result: '' });
    expect(decision).toMatchObject({ type: 'reject' });
    expect((decision as { message: string }).message).toMatch(/sellsTo/);
    expect((decision as { message: string }).message).toMatch(/submit/);
    expect(submit.read({ result: JSON.stringify(bad) })).toBeNull();
    expect(submit.read({ result: 'not json' })).toBeNull();
    expect(submit.read({ result: null })).toBeNull();
  });

  it('with a capture, the result is the captured text and read returns it as is; absence reads null, never empty text', () => {
    const shout = defineOutput('shout', z.object({ result: z.string() }), { capture: ({ result }) => result.toUpperCase() });
    const raw = JSON.stringify({ result: 'quiet' });
    expect(shout.tool.hooks!.onReturn!({ agent, tool: 'shout', args: { result: 'quiet' }, raw, result: 'quiet' })).toEqual({ type: 'accept', result: 'QUIET' });
    expect(shout.read({ result: 'QUIET' })).toBe('QUIET');
    // No outcome is not an empty one: `''` is a value the capture can legitimately make.
    expect(shout.read({ result: null })).toBeNull();
    expect(shout.read({ result: '' })).toBe('');
  });
});

describe('citedReport', () => {
  it('is the `report` terminal whose capture weaves the grammar-forced sources into the findings', () => {
    expect(citedReport.tool.name).toBe('report');
    const args = { result: 'Oslo sits on the fjord, see https://a.io/oslo and https://a.io.', sources: [{ title: 'A', url: 'https://a.io' }, { title: 'Oslo', url: 'https://a.io/oslo' }] };
    const decision = citedReport.tool.hooks!.onReturn!({ agent, tool: 'report', args, raw: JSON.stringify(args), result: args.result });
    expect(decision).toEqual({ type: 'accept', result: 'Oslo sits on the fjord, see [Oslo](https://a.io/oslo) and [A](https://a.io).\n\nSources:\n- [Oslo](https://a.io/oslo)\n- [A](https://a.io)' });
    expect(citedReport.read({ result: (decision as { result: string }).result })).toBe((decision as { result: string }).result);
  });

  it('a dangling <tool_call> at the end of the findings is stripped BEFORE the sources are woven on, so the trailer stands and the fragment never rides into another prompt', () => {
    const args = {
      result: 'Oslo sits on the fjord, see https://a.io/oslo.\n\n<tool_call>\n{"name": "web_search", "argu',
      sources: [{ title: 'Oslo', url: 'https://a.io/oslo' }],
    };
    const decision = citedReport.tool.hooks!.onReturn!({ agent, tool: 'report', args, raw: JSON.stringify(args), result: args.result });
    expect(decision).toEqual({ type: 'accept', result: 'Oslo sits on the fjord, see [Oslo](https://a.io/oslo).\n\nSources:\n- [Oslo](https://a.io/oslo)' });
  });

  it('a complete <tool_call> block inside the findings is left alone', () => {
    const args = { result: 'Findings <tool_call>{}</tool_call> end.', sources: [] };
    const decision = citedReport.tool.hooks!.onReturn!({ agent, tool: 'report', args, raw: JSON.stringify(args), result: args.result });
    expect(decision).toEqual({ type: 'accept', result: 'Findings <tool_call>{}</tool_call> end.' });
  });

  it('a report without its sources is rejected, not accepted', () => {
    const decision = citedReport.tool.hooks!.onReturn!({ agent, tool: 'report', args: { result: 'findings' }, raw: '{"result":"findings"}', result: 'findings' });
    expect(decision).toMatchObject({ type: 'reject' });
    expect((decision as { message: string }).message).toMatch(/sources/);
  });
});

describe('weaveSourcesIntoResult', () => {
  it('wraps bare urls, leaves linked and parenthesised ones, stops at a url boundary, dedups, longest first, and appends the list', () => {
    const out = weaveSourcesIntoResult(
      'See https://x.com/page and https://x.com (also [X](https://x.com)) and (https://x.com/page).',
      [{ title: 'X', url: 'https://x.com' }, { title: 'Page [2024]', url: 'https://x.com/page' }, { title: 'X again', url: 'https://x.com' }],
    );
    expect(out).toBe('See [Page \\[2024\\]](https://x.com/page) and [X](https://x.com) (also [X](https://x.com)) and (https://x.com/page).\n\nSources:\n- [Page \\[2024\\]](https://x.com/page)\n- [X](https://x.com)');
  });

  it('returns the result unchanged with no usable sources, and never touches a non-string', () => {
    expect(weaveSourcesIntoResult('r', [])).toBe('r');
    expect(weaveSourcesIntoResult('r', [{ title: '', url: 'https://a' }, 3, null])).toBe('r');
    expect(weaveSourcesIntoResult(7, [{ title: 'A', url: 'https://a' }])).toBe(7);
  });
});
