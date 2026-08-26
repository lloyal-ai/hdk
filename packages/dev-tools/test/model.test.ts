/**
 * The pane model — the node-free fold the react and ink surfaces render.
 * Times are injected, so every behavior is clock-free and deterministic.
 */
import { describe, it, expect } from 'vitest';
import {
  createPaneModel,
  foldEvent,
  pressurePercent,
  pressureStrip,
  sparkline,
  readConfigPath,
  KEY_TIERS,
  PROVENANCE_RUNGS,
} from '../src/index';

const ready = (_dev: boolean) => ({
  type: 'ready',
  facts: { surface: 'cli', model: { id: 'qwen3.5-4b', sizeBytes: 42 }, abilities: ['corpus'] },
});

describe('the dev gate', () => {
  it('config:loaded.dev is the gate — absent or false means NO pane, ever', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'config:loaded', config: {}, origin: {} }, 0);
    expect(m.dev).toBe(false);
    foldEvent(m, { type: 'config:loaded', config: {}, origin: {}, dev: true }, 1);
    expect(m.dev).toBe(true);
    // ready.facts is display-only and has no say in the gate.
    foldEvent(m, ready(true), 2);
    expect(m.facts?.surface).toBe('cli');
  });
});

describe('config + provenance', () => {
  it('config:loaded seeds config/origin; config:updated moves them TOGETHER with savedTo', () => {
    const m = createPaneModel();
    foldEvent(m, {
      type: 'config:loaded',
      config: { defaults: { effort: 'high' }, model: { nCtx: 32768 } },
      origin: { nCtx: 'yml', outputDir: 'default' },
    }, 0);
    expect(readConfigPath(m.config, 'defaults.effort')).toBe('high');
    expect(m.origin?.nCtx).toBe('yml');
    expect(m.lastSavedTo).toBeUndefined(); // no save yet — footer renders nothing

    foldEvent(m, {
      type: 'config:updated',
      config: { defaults: { effort: 'low' }, model: { nCtx: 32768 } },
      origin: { nCtx: 'yml', outputDir: 'file' },
      savedTo: '/proj/harness.json',
    }, 1);
    expect(readConfigPath(m.config, 'defaults.effort')).toBe('low');
    expect(m.lastSavedTo).toBe('/proj/harness.json');
  });

  it('a served save reports savedTo null — the honest "this session only"', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'config:updated', config: {}, origin: {}, savedTo: null }, 0);
    expect(m.lastSavedTo).toBeNull();
  });

  it('the vocabulary is exactly the six real rungs', () => {
    expect(PROVENANCE_RUNGS.map((r) => r.rung)).toEqual([
      'cli', 'env', 'file', 'yml', 'session', 'default',
    ]);
    expect(KEY_TIERS['model.nCtx']).toBe('boot');
    expect(KEY_TIERS['model.gpu']).toBe('reload');
    expect(KEY_TIERS['defaults.effort']).toBe('session');
  });
});

describe('agent lanes', () => {
  it('spawn→produce→done is a span; tokenCount is CUMULATIVE (latest, never summed)', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'agent:spawn', agentId: 3, parentAgentId: 1 }, 100);
    foldEvent(m, { type: 'agent:produce', agentId: 3, text: 'a', tokenCount: 1 }, 110);
    foldEvent(m, { type: 'agent:produce', agentId: 3, text: 'b', tokenCount: 2 }, 120);
    foldEvent(m, { type: 'agent:done', agentId: 3 }, 200);
    const lane = m.lanes.get(3)!;
    expect(lane.parentAgentId).toBe(1);
    expect(lane.tokenCount).toBe(2);
    expect(lane.spawnedAt).toBe(100);
    expect(lane.doneAt).toBe(200);
    expect(lane.outcome).toBe('done');
  });

  it('recovered upgrades a done lane; failed carries the reason and closes an open span', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'agent:spawn', agentId: 3, parentAgentId: 1 }, 0);
    foldEvent(m, { type: 'agent:done', agentId: 3 }, 10);
    foldEvent(m, { type: 'agent:recovered', agentId: 3, result: 'r' }, 20);
    expect(m.lanes.get(3)!.outcome).toBe('recovered');

    foldEvent(m, { type: 'agent:spawn', agentId: 5, parentAgentId: 1 }, 30);
    foldEvent(m, { type: 'agent:failed', agentId: 5, reason: 'user_cancel' }, 40);
    const failed = m.lanes.get(5)!;
    expect(failed.outcome).toBe('failed');
    expect(failed.failReason).toBe('user_cancel');
    expect(failed.doneAt).toBe(40);
  });
});

describe('retrievals (Sources)', () => {
  it('a call/result pair settles the OLDEST unsettled call for that agent+tool', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'agent:spawn', agentId: 3, parentAgentId: 1 }, 0);
    foldEvent(m, { type: 'agent:tool_call', agentId: 3, tool: 'search', args: '{"query":"q"}' }, 10);
    expect(m.lanes.get(3)!.inflightTool).toBe('search');
    foldEvent(m, {
      type: 'agent:tool_result', agentId: 3, tool: 'search',
      result: '{"content":"…"}', contextAvailablePercent: 69,
    }, 500);
    const r = m.retrievals[0];
    expect(r.settledAt).toBe(500);
    expect(r.contextAvailablePercent).toBe(69);
    expect(m.lanes.get(3)!.inflightTool).toBeNull();
  });
});

describe('pressure', () => {
  it('percent reads the latest tick; the strip downsamples against TIME, not index', () => {
    const m = createPaneModel();
    // Dense early ticks, sparse late ones — index-based bucketing would put
    // half the buckets in the first second; time-based puts them across the span.
    for (let i = 0; i < 100; i++) foldEvent(m, { type: 'agent:tick', cellsUsed: 100 + i, nCtx: 1000 }, i * 10);
    foldEvent(m, { type: 'agent:tick', cellsUsed: 900, nCtx: 1000 }, 100_000);
    expect(pressurePercent(m)).toBe(90);
    const strip = pressureStrip(m, 10);
    expect(strip.length).toBeLessThanOrEqual(10);
    // The dense first second collapses into ONE leading bucket.
    expect(strip[0].at).toBeLessThan(1000);
    expect(strip[strip.length - 1].pct).toBeCloseTo(90, 0);
    const spark = sparkline(m, 10);
    expect(spark.length).toBe(strip.length);
  });

  it('a stale tool_result cannot blank a newer in-flight marker; buckets<=0 is empty', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'agent:spawn', agentId: 3, parentAgentId: 1 }, 0);
    foldEvent(m, { type: 'agent:tool_call', agentId: 3, tool: 'search', args: '' }, 1);
    foldEvent(m, { type: 'agent:tool_call', agentId: 3, tool: 'fetch_page', args: '' }, 2);
    // A late result for the EARLIER tool settles its retrieval but must not
    // clear the newer in-flight marker.
    foldEvent(m, { type: 'agent:tool_result', agentId: 3, tool: 'search', result: '{}' }, 3);
    expect(m.lanes.get(3)!.inflightTool).toBe('fetch_page');
    foldEvent(m, { type: 'agent:tick', cellsUsed: 1, nCtx: 10 }, 4);
    expect(pressureStrip(m, 0)).toEqual([]);
    expect(pressureStrip(m, -3)).toEqual([]);
  });

  it('caps hold: the series and retrieval list never grow without bound', () => {
    const m = createPaneModel();
    for (let i = 0; i < 25_000; i++) foldEvent(m, { type: 'agent:tick', cellsUsed: i, nCtx: 0 }, i);
    expect(m.pressure.length).toBeLessThanOrEqual(20_000);
    foldEvent(m, { type: 'agent:spawn', agentId: 1, parentAgentId: 0 }, 0);
    for (let i = 0; i < 600; i++) foldEvent(m, { type: 'agent:tool_call', agentId: 1, tool: 't', args: '' }, i);
    expect(m.retrievals.length).toBeLessThanOrEqual(500);
  });
});
