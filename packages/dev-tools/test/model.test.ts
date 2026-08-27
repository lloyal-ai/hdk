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

describe('run phases + the planner truth', () => {
  it('phase markers tag spawns with roles; the plan event outranks recovery_skipped', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'plan:start', query: 'q', mode: 'flat' }, 0);
    foldEvent(m, { type: 'query', query: 'q', warm: false }, 1);
    foldEvent(m, { type: 'agent:spawn', agentId: 2, parentAgentId: 1 }, 2);
    expect(m.lanes.get(2)!.role).toBe('planner');
    foldEvent(m, { type: 'agent:done', agentId: 2 }, 10);
    foldEvent(m, { type: 'plan', tasks: [] }, 11);
    foldEvent(m, { type: 'agent:failed', agentId: 2, reason: 'recovery_skipped' }, 12);
    const planner = m.lanes.get(2)!;
    // The plan ARRIVED — the pool's nothing-to-salvage mechanics must not
    // paint the planner as a run failure. The raw reason stays for detail.
    expect(planner.outcome).toBe('done');
    expect(planner.failReason).toBe('recovery_skipped');

    foldEvent(m, { type: 'research:start', agentCount: 2, mode: 'flat' }, 20);
    foldEvent(m, { type: 'agent:spawn', agentId: 3, parentAgentId: 1 }, 21);
    expect(m.lanes.get(3)!.role).toBe('research');
    foldEvent(m, { type: 'synthesize:start' }, 30);
    foldEvent(m, { type: 'agent:spawn', agentId: 9, parentAgentId: 1 }, 31);
    expect(m.lanes.get(9)!.role).toBe('synth');
  });

  it('a new run resets the run-scoped state and anchors the axis', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'agent:spawn', agentId: 2, parentAgentId: 1 }, 5);
    foldEvent(m, { type: 'agent:tick', cellsUsed: 1, nCtx: 10 }, 6);
    foldEvent(m, { type: 'plan:start', query: 'next', mode: 'flat' }, 100);
    expect(m.lanes.size).toBe(0);
    expect(m.pressure.length).toBe(0);
    expect(m.runStartAt).toBe(100);
    // plan:start then query back-to-back must not double-reset a fresh run.
    foldEvent(m, { type: 'agent:spawn', agentId: 4, parentAgentId: 1 }, 101);
    foldEvent(m, { type: 'query', query: 'next', warm: false }, 101);
    expect(m.lanes.size).toBe(1);
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

// ── the tee vocabulary: interventions, retrieval metadata, plan, clarify ──

function freshRun() {
  const m = createPaneModel();
  foldEvent(m, { type: 'config:loaded', dev: true, config: {}, origin: {} }, 0);
  foldEvent(m, { type: 'plan:start' }, 1000);
  foldEvent(m, { type: 'agent:spawn', agentId: 2, parentAgentId: 1 }, 1100);
  return m;
}

describe('interventions (agent:trace mirrors)', () => {
  it('a guard nudge folds as kind guard, a plain nudge as nudge, authReject as auth', () => {
    const m = freshRun();
    foldEvent(m, { type: 'agent:trace', agentId: 2, event: {
      type: 'pool:agentNudge', traceId: 1, parentTraceId: null, ts: 1,
      reason: 'nudge', message: 'already searched', tool: 'web_search', args: '"q"', guard: 'query_dedup',
    } }, 2000);
    foldEvent(m, { type: 'agent:trace', agentId: 2, event: {
      type: 'pool:agentNudge', traceId: 2, parentTraceId: null, ts: 2,
      reason: 'nudge', message: 'report now within 220 words',
    } }, 2100);
    foldEvent(m, { type: 'agent:trace', agentId: 2, event: {
      type: 'tool:authReject', traceId: 3, parentTraceId: null, ts: 3, attemptedTool: 'write_file',
    } }, 2200);
    expect(m.interventions.map((i) => i.kind)).toEqual(['guard', 'nudge', 'auth']);
    expect(m.interventions[0]).toMatchObject({ guard: 'query_dedup', tool: 'web_search' });
    expect(m.interventions[2].tool).toBe('write_file');
  });

  it('pool:agentDrop and branch:prune land on the lane', () => {
    const m = freshRun();
    foldEvent(m, { type: 'agent:trace', agentId: 2, event: {
      type: 'pool:agentDrop', traceId: 1, parentTraceId: null, ts: 1, reason: 'pressure_critical',
    } }, 2000);
    foldEvent(m, { type: 'agent:trace', agentId: 2, event: {
      type: 'branch:prune', traceId: 2, parentTraceId: null, ts: 2, branchHandle: 2, position: 900,
    } }, 2100);
    const lane = m.lanes.get(2)!;
    expect(lane.dropReason).toBe('pressure_critical');
    expect(lane.prunedAt).toBe(2100);
  });
});

describe('retrieval metadata (the admission funnel, live)', () => {
  it('tool:dispatch keys the call; rerank:end + exploit attach by callId', () => {
    const m = freshRun();
    foldEvent(m, { type: 'agent:tool_call', agentId: 2, tool: 'fetch_page', args: '{"url":"u","query":"q"}' }, 2000);
    foldEvent(m, { type: 'agent:trace', agentId: 2, event: {
      type: 'tool:dispatch', traceId: 1, parentTraceId: null, ts: 1,
      agentId: 2, tool: 'fetch_page', toolIndex: 0, toolkitSize: 1,
      args: {}, callId: 'call_7', explore: false, percentAvailable: 38,
    } }, 2001);
    foldEvent(m, { type: 'agent:trace', agentId: 2, callId: 'call_7', event: {
      type: 'entailment:content:exploit', traceId: 2, parentTraceId: 1, ts: 2,
      tool: 'fetch_page', pressure: { percentAvailable: 38 },
      chunks: [{ heading: 'A', toolQueryScore: 0.6, combinedScore: 0.9 }],
    } }, 2002);
    foldEvent(m, { type: 'agent:trace', agentId: 2, callId: 'call_7', event: {
      type: 'rerank:end', traceId: 3, parentTraceId: 1, ts: 3,
      topResults: [{ file: 'u', heading: 'A', score: 0.9, textPreview: 'p' }],
      selectedPassageCount: 1, totalChars: 100, durationMs: 5,
      topK: 5, tokenBudget: 2048, admittedTokens: 700, totalScored: 12,
    } }, 2003);
    foldEvent(m, { type: 'agent:tool_result', agentId: 2, tool: 'fetch_page', result: '{"content":"…"}' }, 2004);

    const r = m.retrievals[0];
    expect(r.callId).toBe('call_7');
    expect(r.explore).toBe(false);
    expect(r.admission).toMatchObject({ topK: 5, tokenBudget: 2048, admittedTokens: 700, totalScored: 12 });
    expect(r.exploitChunks).toEqual([{ heading: 'A', toolQueryScore: 0.6, combinedScore: 0.9 }]);
    expect(r.settledAt).toBe(2004);
  });
});

describe('plan structure + clarify continuation', () => {
  it('a research plan captures ordered task descriptions', () => {
    const m = freshRun();
    foldEvent(m, { type: 'plan', intent: 'research', tasks: [{ description: 'T1' }, { description: 'T2' }], clarifyQuestions: [] }, 3000);
    expect(m.plan).toEqual({ intent: 'research', tasks: ['T1', 'T2'] });
    expect(m.lanes.get(2)!.outcome).toBe('done');
  });

  it('a clarify plan parks the planner on the user; the next cycle CONTINUES the run', () => {
    const m = freshRun();
    foldEvent(m, { type: 'plan', intent: 'clarify', tasks: [], clarifyQuestions: ['Which sense?'] }, 3000);
    const lane = m.lanes.get(2)!;
    expect(lane.clarify).toEqual({ questions: ['Which sense?'], askedAt: 3000, answeredAt: null });
    expect(lane.outcome).toBe('running');
    // The user answers minutes later — plan:start again must NOT reset the run.
    foldEvent(m, { type: 'plan:start' }, 120_000);
    expect(m.lanes.size).toBe(1);
    expect(lane.clarify!.answeredAt).toBe(120_000);
    expect(m.runStartAt).toBe(1000);
  });
});

describe('reports', () => {
  it('agent:return delivers; agent:recovered marks extraction', () => {
    const m = freshRun();
    foldEvent(m, { type: 'agent:return', agentId: 2, result: 'findings' }, 4000);
    expect(m.lanes.get(2)!).toMatchObject({ report: 'findings', reportSource: 'voluntary' });
    foldEvent(m, { type: 'agent:spawn', agentId: 3, parentAgentId: 1 }, 4100);
    foldEvent(m, { type: 'agent:recovered', agentId: 3, result: 'salvaged' }, 4200);
    expect(m.lanes.get(3)!).toMatchObject({ report: 'salvaged', reportSource: 'recovery', outcome: 'recovered' });
  });
});

describe('parked retries (agent:tool_retry)', () => {
  it('a transient failure parks the call — never bare in-flight', () => {
    const m = freshRun();
    foldEvent(m, { type: 'agent:tool_call', agentId: 2, tool: 'web_search', args: '{"query":"q"}' }, 2000);
    foldEvent(m, { type: 'agent:tool_retry', agentId: 2, tool: 'web_search', retryAfterMs: 90000, attempt: 1 }, 5200);
    expect(m.retrievals[0].retry).toEqual({ at: 5200, afterMs: 90000, attempt: 1 });
    // the eventual settle closes the SAME call
    foldEvent(m, { type: 'agent:tool_result', agentId: 2, tool: 'web_search', result: '{"error":"failed"}' }, 101_000);
    expect(m.retrievals[0].settledAt).toBe(101_000);
  });
});

describe('abilities:state (the Settings nav + form source)', () => {
  it('descriptors fold with redacted config; installed ≠ configured', () => {
    const m = createPaneModel();
    foldEvent(m, { type: 'config:loaded', dev: true, config: { abilities: {} }, origin: {} }, 0);
    foldEvent(m, { type: 'abilities:state', abilities: [
      { name: 'web', title: 'Web research', description: 'search + fetch',
        configSchema: { properties: { tavilyKey: { type: 'string', 'x-secret': true } } },
        config: {}, enabled: true },
      { name: 'corpus', configSchema: { properties: { corpusPath: { type: 'string' } } },
        config: { corpusPath: true }, enabled: true },
    ] }, 100);
    expect(m.abilities!.map((a) => a.name)).toEqual(['web', 'corpus']);
    // web is INSTALLED but unconfigured — exactly the ability you need the
    // form for; the old configured-keys nav could never show it.
    expect(m.abilities![0].config).toEqual({});
    expect(m.abilities![1].config.corpusPath).toBe(true);
  });
});

describe('epistemics', () => {
  it('entropy/surprisal accumulate bounded when the wire carries them, absent otherwise', () => {
    const m = freshRun();
    foldEvent(m, { type: 'agent:produce', agentId: 2, text: 'x', tokenCount: 1, entropy: 2.1, surprisal: 0.4 }, 2000);
    foldEvent(m, { type: 'agent:produce', agentId: 2, text: 'y', tokenCount: 2 }, 2001);
    const lane = m.lanes.get(2)!;
    expect(lane.entropy).toEqual([2.1]);
    expect(lane.surprisal).toEqual([0.4]);
    expect(lane.tokenCount).toBe(2);
  });
});
