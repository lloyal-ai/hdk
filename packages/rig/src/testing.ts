/**
 * `runHarness(spec)` — the behavioural rig for an application: drives the REAL
 * `harness(ctx, events, commands)` over a scripted `MockSessionContext` and
 * captures everything a scenario can assert on — the wire (every event, in
 * order), the engine trace (the trunk's `warmDelta` commits and `branch:prune`
 * releases: the KV law as data), and the run-dir tree on disk.
 *
 * The pattern is lifted from the agents package's own invariants (`runPool`):
 * scripted determinism, event-driven choreography, no timers. What is new is
 * the layer — the command loop, the identity pointers, and the pipeline
 * composition all run REAL; only the model and the reranker are scripted. An
 * application's test rig is this plus its own vocabulary: what its commands
 * are called, what a fixture on disk looks like, which event mints an id.
 *
 * Scripting model — utterances, not fork indices. Each branch that SAMPLES for
 * the first time is assigned the next entry of `spec.utterances` (run order is
 * deterministic under the single-fiber pool). A branch streams `stallTokens`
 * filler ticks first (scheduling room for the command loop to interleave — how
 * "during a live run" scenarios exist without timers), then ONE fat token whose
 * text is the whole utterance, then stop.
 *
 *   kind 'text'   → parseChatOutput presents it as free-text content: the
 *                   JSON a grammar-constrained agent emits, or prose.
 *   kind 'report' → parseChatOutput presents it as a call of the terminal
 *                   (`spec.terminal`, default rig's `report` with `sources`) —
 *                   what an agent produces to end its turn voluntarily.
 *   kind 'tool'   → a call of `tool.name` with `tool.args`; the branch's next
 *                   turn, after the result is prefilled, is `then`.
 *
 * Choreography — `script` is a cursor of steps walked by the event stream:
 *   { send }      fire a command now (buffered until the loop arms).
 *   { on, send? } wait until an event matches, then optionally fire.
 * When the last step resolves, the rig sends `quit`; the harness returns; the
 * captured run comes back. A 30s watchdog fails loud instead of hanging.
 *
 * @category Rig
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from 'effection';
import type { Operation, Signal } from 'effection';
import { MockSessionContext } from '@lloyal-labs/sdk/dist/testing.js';
import type { SessionContext } from '@lloyal-labs/sdk';
import { createBus } from '@lloyal-labs/binding';
import type { EventBus } from '@lloyal-labs/binding';
import { RerankerCtx } from '@lloyal-labs/lloyal-agents';
import type { Reranker, TraceWriter, TraceEvent } from '@lloyal-labs/lloyal-agents';
import type { AttachmentStore } from '@lloyal-labs/media';
import { bufferedCommandSignal } from './buffered-command-signal';
import { makeServedRunner, RunnerCtx } from './runner';
import { runnerConfig } from './config-layering';
import type { ConfigTable, ConfigOf, OriginOf, YmlOf } from './config';
import type { BaseHarnessConfig } from './runner';
import type { Reports } from './tools/report';
import { RIG_REPORT } from './tools';

const STOP = 999;
const FILLER = 7;
const UTTER_BASE = 50_000;

/** What every utterance carries, whatever it is presented as. */
interface Said {
  /** The branch's whole output — a plan's JSON, prose, the text of a terminal call. */
  text: string;
  /** The same branch's next turn — after a tool result, or the recovery turn a reaped agent is given. A function is
   *  asked when that turn begins, so a scenario can decide it from what the wire has said since. */
  then?: Utterance | (() => Utterance | undefined);
  /** Filler ticks streamed before the utterance — scheduling room for the
   *  command loop. A "live run" a scenario interrupts wants hundreds. */
  stallTokens?: number;
}

/** One scripted turn, by how parseChatOutput presents it (see module doc): a tool turn names its call, a
 *  report may carry its grammar-forced sources. */
export type Utterance =
  | (Said & { kind: 'text' })
  | (Said & { kind: 'report'; sources?: { title: string; url: string }[] })
  | (Said & { kind: 'tool'; tool: { name: string; args: Record<string, unknown> } });

/** A step's command may be a THUNK, resolved at fire time — for commands
 *  that need data only the wire revealed (a minted id captured by an
 *  earlier step's matcher). */
export type Sendable<C> = C | (() => C);

export type Step<C, E> =
  | { send: Sendable<C> }
  | { on: (ev: E) => boolean; send?: Sendable<C> }
  /** Poll for loop-fiber state that has NO wire announcement: send `poke`
   *  commands whose echoes reveal the state; advance when `until` matches;
   *  re-poke when `repoke` matches (the pacing echo). Deterministic — the
   *  until-echo can only fire once the state exists. */
  | { until: (ev: E) => boolean; repoke: (ev: E) => boolean; poke: C[]; send?: Sendable<C> };

/** The application under test: its composition and its config. */
export interface HarnessUnderTest<T extends ConfigTable, C extends { type: string }, E extends { type: string }> {
  /** The composition to run — the app's `harness(ctx, events, commands)`. */
  harness: (ctx: SessionContext, events: EventBus<E>, commands: Signal<C, void>) => Operation<void>;
  /** The app's config table, and the yml this run stands on — its library in the rig's fresh temp dir at least. */
  config: { table: T; yml: (outputDir: string) => YmlOf<T> };
}

export interface HarnessSpec<T extends ConfigTable, C extends { type: string }, E extends { type: string }>
  extends HarnessUnderTest<T, C, E> {
  /** Merged over the loaded config, one level deep (an object key merges, anything else replaces). */
  override?: { [K in keyof ConfigOf<T>]?: ConfigOf<T>[K] extends object ? Partial<ConfigOf<T>[K]> : ConfigOf<T>[K] };
  utterances?: Utterance[];
  script?: Step<C, E>[];
  /** Runs after the temp library dir exists, before the harness boots —
   *  where a scenario plants fixtures. */
  setup?: (outputDir: string) => void;
  /** Wrap/override any ctx method AFTER the rig's scripting is wired but
   *  BEFORE the harness runs. Diagnosis and fault injection. */
  instrument?: (ctx: MockSessionContext) => void;
  /** The content store the harness resolves attachments through. A scenario
   *  that attaches something commits it here first, then names its root on
   *  the command. Defaults to the runner's own (a null store). */
  attachmentStore?: AttachmentStore;
  /** Hands the scenario the controls the wire does not carry: `halt` ends the
   *  task that runs `harness()` — the scope that owns `initAgents` and so the
   *  context — the way a disconnect does, from wherever the scenario stands
   *  (an instrumented native call included, where no event can flow);
   *  `send` fires a command from the same places; `eventCount` is how many
   *  events the wire has carried so far. A halted run returns normally with
   *  `halted: true`. */
  controls?: (c: { halt: () => Promise<void>; send: (c: C) => void; eventCount: () => number }) => void;
  /** Every event the wire carries, as it arrives — for a script that must remember something the wire announced
   *  (a revision number, a minted id) before a later step sends it back. */
  observe?: (ev: E) => void;
  /** Run once, non-interactive, with this query: the Runner's `oneshot` mode. The harness's own failure comes
   *  back as `failure` instead of throwing. */
  oneshot?: string;
  /** The mock context's sequence budget — how many branches may be alive at once. Unbounded by default. */
  nSeqMax?: number;
  /** The terminal a `kind: 'report'` utterance is presented as a call of. Defaults to rig's own `report`, with
   *  the utterance's `sources` beside its `result`. */
  terminal?: Reports & { field: string };
}

export interface HarnessRun<E> {
  /** Every event the wire carried, in order. */
  events: E[];
  /** Every trace write — `branch:prefill role='warmDelta'` is a trunk
   *  commit; `branch:prune` of a warmDelta's handle is a trunk release. */
  trace: TraceEvent[];
  /** The library/run-dir root this run wrote (a fresh temp dir). */
  outputDir: string;
  /** `trace.length` at the moment quit was sent, or the scenario halted the run. Trace entries at or past
   *  this index are SHUTDOWN work (scope teardown disposes the live trunk,
   *  which rightly emits a release) — a scenario asserting "the trunk was
   *  never released" means never released BEFORE this mark. */
  shutdownTraceIndex: number;
  /** The run ended by the scenario's `halt`, not by `quit`. */
  halted: boolean;
  /** `trace.length` when each event arrived: `traceAt[i]` is the trace position of `events[i]`. */
  traceAt: number[];
  /** In `oneshot` mode: what the harness threw, if it did. */
  failure?: unknown;
}

class CapturingTrace implements TraceWriter {
  readonly events: TraceEvent[] = [];
  private _id = 1;
  nextId(): number {
    return this._id++;
  }
  write(event: TraceEvent): void {
    this.events.push(event);
    if (process.env.RIG_DEBUG === '1') {
      const e = event as TraceEvent & { role?: string; branchHandle?: number };
      console.error(`[rig] trace ${e.type}${e.role ? ` role=${e.role}` : ''}${e.branchHandle !== undefined ? ` h=${e.branchHandle}` : ''}`);
    }
  }
  flush(): void {}
}

/** A reranker that satisfies the ability factories and scores everything 0:
 *  every chunk is admitted, in the order given, none ranked above another.
 *  Scenarios never assert on relevance — a real reranker is the platform's
 *  concern, not the application's. (Admission keeps the LAST batch a reranker
 *  yields; a stub that yields none would admit nothing, and every retrieval
 *  under the rig would come back empty whatever the fixtures held.) */
export const stubReranker: Reranker = {
  score: async function* (_query, chunks) {
    yield {
      results: chunks.map((c) => ({ file: c.resource, heading: c.heading, section: c.section, snippet: c.text.slice(0, 200), score: 0, startLine: c.startLine, endLine: c.endLine })),
      filled: chunks.length,
      total: chunks.length,
    };
  },
  scoreBatch: async (_q, texts) => texts.map(() => 0),
  tokenizeChunks: async () => {},
  tokenize: async () => [],
  dispose: () => {},
};

/** The document folders under a library root, sorted. */
export const dirs = (outputDir: string): string[] =>
  fs.readdirSync(outputDir).filter((n) => fs.statSync(path.join(outputDir, n)).isDirectory()).sort();

export async function runHarness<T extends ConfigTable, C extends { type: string }, E extends { type: string }>(
  spec: HarnessSpec<T, C, E>,
): Promise<HarnessRun<E>> {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-inv-'));
  spec.setup?.(outputDir);
  const utterances = spec.utterances ?? [];
  const steps = spec.script ?? [];

  const ctx = new MockSessionContext({ nCtx: 32_768, ...(spec.nSeqMax !== undefined ? { nSeqMax: spec.nSeqMax } : {}) });

  // ── The utterance wiring (see module doc) ──
  // Every turn is numbered the first time a branch streams it: the fat token names its turn.
  const turns: Utterance[] = [];
  const turnIndex = new Map<Utterance, number>();
  let nextUtterance = 0;
  /** Per branch: the turn streaming now (`u`), the turn after it (`next`, taken up when `u` is over), the one it last
   *  finished (`last`, what parseChatOutput presents), and how many tokens of the current turn it has produced. */
  const assigned = new Map<number, { u: Utterance | undefined; next: Utterance['then']; last: Utterance | undefined; produced: number }>();
  let lastSampled = 0;
  ctx._branchSample = (handle: number): number => {
    lastSampled = handle;
    let a = assigned.get(handle);
    if (!a) {
      a = { u: utterances[nextUtterance++], next: undefined, last: undefined, produced: 0 };
      assigned.set(handle, a);
    }
    if (a.u === undefined && a.next !== undefined) {
      a.u = typeof a.next === 'function' ? a.next() : a.next;   // the next turn, decided as it begins
      a.next = undefined;
      a.produced = 0;
    }
    const u = a.u;
    if (!u) { a.last = undefined; return STOP; } // unscripted branch, or a turn past its script — stops at once
    if (!turnIndex.has(u)) { turnIndex.set(u, turns.length); turns.push(u); }
    const stall = u.stallTokens ?? 0;
    a.produced++;
    if (a.produced <= stall) return FILLER;
    if (a.produced === stall + 1) return UTTER_BASE + turnIndex.get(u)!;
    a.last = u;   // the turn is over; a branch with a `then` starts it next, one without says the same thing again
    if (u.then !== undefined) { a.u = undefined; a.next = u.then; }
    return STOP;
  };
  ctx.tokenToText = (token: number): string => {
    if (token >= UTTER_BASE) return turns[token - UTTER_BASE]?.text ?? '';
    return token === FILLER ? ' .' : '';
  };
  /** The text a turn produced, as the pool accumulated it: its filler ticks, then its one fat token. */
  const producedBy = (u: Utterance): string => ' .'.repeat(u.stallTokens ?? 0) + u.text;
  /** What a turn is presented as, for telling two turns with the same text apart. */
  const presentation = (u: Utterance): string => JSON.stringify(u.kind === 'tool' ? u.tool : u.kind === 'report' ? [u.text, u.sources ?? []] : u.text);
  ctx.parseChatOutput = (output, _format, opts) => {
    // The strict parse belongs to the OUTPUT, not to the branch sampled last: an extracting agent's parse is
    // deferred past its siblings' samples (`apply.ts` `finishExtraction`), so two recoveries stopping in one
    // tick would otherwise both read the last branch's turn. The branch sampled last is asked first (its own
    // parse follows its own sample); then any branch whose last turn produced this text. Two turns with the
    // same text but different presentations (two tool calls with different arguments, say) are a fixture the
    // rig cannot tell apart from the text alone, and it says so rather than guess.
    const last = assigned.get(lastSampled)?.last;
    let u: Utterance | undefined = last && producedBy(last) === output ? last : undefined;
    if (!u) {
      const candidates = [...assigned.values()].map((a) => a.last).filter((t): t is Utterance => !!t && producedBy(t) === output);
      const distinct = new Set(candidates.map(presentation));
      if (distinct.size > 1) {
        throw new Error(`runHarness: ${distinct.size} scripted turns produce the same text ${JSON.stringify(output)} but are presented differently — give them distinct text`);
      }
      u = candidates[0] ?? last;
    }
    if (opts?.isPartial || !u) {
      return { content: '', reasoningContent: '', toolCalls: [] };
    }
    if (u.kind === 'tool') {
      return {
        content: '',
        reasoningContent: '',
        toolCalls: [{ id: 'c1', name: u.tool.name, arguments: JSON.stringify(u.tool.args) }],
      };
    }
    if (u.kind === 'report') {
      return {
        content: '',
        reasoningContent: '',
        toolCalls: [
          {
            id: 'c1',
            name: spec.terminal?.tool ?? RIG_REPORT.tool,
            arguments: JSON.stringify(spec.terminal ? { [spec.terminal.field]: u.text } : { result: u.text, sources: u.sources ?? [] }),
          },
        ],
      };
    }
    return { content: u.text || output, reasoningContent: '', toolCalls: [] };
  };

  spec.instrument?.(ctx);

  const trace = new CapturingTrace();
  // The app's own table, layered over its yml for this run, with the rig's temp dir as the cwd.
  const loaded = runnerConfig(spec.config.table, spec.config.yml(outputDir), { env: {}, cwd: outputDir });
  const cfg = { ...loaded.config } as Record<string, unknown>;
  for (const [key, value] of Object.entries(spec.override ?? {})) {
    const standing = cfg[key];
    cfg[key] = isPlainObject(standing) && isPlainObject(value) ? { ...standing, ...value } : value;
  }
  type Cfg = ConfigOf<T> & BaseHarnessConfig;
  const served = makeServedRunner<Cfg, OriginOf<T>>(cfg as Cfg, {
    traceWriter: trace,
    dev: false,
    origin: loaded.origin,
    sessionOriginMap: loaded.sessionOriginMap,
    frozen: loaded.frozen,
    ...(spec.attachmentStore ? { attachmentStore: spec.attachmentStore } : {}),
  });
  const runner: typeof served = spec.oneshot === undefined ? served : { ...served, mode: 'oneshot', initialQuery: spec.oneshot };

  const events: E[] = [];
  const traceAt: number[] = [];
  const bus = createBus<E>();
  const rawCommands = bufferedCommandSignal<C>();
  // RIG_DEBUG=1 narrates the choreography — every event with the cursor
  // position, every command sent. The first thing to reach for when a
  // scenario stalls.
  const debug = process.env.RIG_DEBUG === '1';
  const commands: typeof rawCommands = !debug ? rawCommands : {
    ...rawCommands,
    send: (c: C) => {
      console.error(`[rig] send ${c.type}`);
      rawCommands.send(c);
    },
  };

  const fire = (c: Sendable<C>): void =>
    commands.send(typeof c === 'function' ? (c as () => C)() : c);

  // ── The choreography cursor ──
  let cursor = 0;
  let quitSent = false;
  let shutdownTraceIndex = -1;
  const finish = (): void => {
    if (!quitSent && cursor >= steps.length) {
      quitSent = true;
      shutdownTraceIndex = trace.events.length;
      commands.send({ type: 'quit' } as C);
    }
  };
  /** Advance through immediate sends and arm the next waiting step (a poll
   *  step fires its pokes on arrival). */
  const enterStep = (): void => {
    for (;;) {
      if (cursor >= steps.length) {
        finish();
        return;
      }
      const st = steps[cursor];
      if ('until' in st) {
        for (const c of st.poke) commands.send(c);
        return;
      }
      if ('on' in st) return;
      fire(st.send);
      cursor++;
    }
  };
  bus.subscribe((ev) => {
    events.push(ev);
    traceAt.push(trace.events.length);
    spec.observe?.(ev);
    if (debug) console.error(`[rig] ev ${ev.type}${'message' in ev ? ` ${JSON.stringify((ev as { message: unknown }).message)}` : ''} (cursor ${cursor}/${steps.length})`);
    if (cursor >= steps.length) return;
    const st = steps[cursor];
    if ('until' in st) {
      if (st.until(ev)) {
        cursor++;
        if (st.send) fire(st.send);
        enterStep();
      } else if (st.repoke(ev)) {
        // Re-poke through a MACROTASK: effection delivers signal/channel
        // sends via synchronous reductions, so a same-tick re-poke forms an
        // unbroken sync cycle that starves the microtask queue — the run
        // fiber's awaits (the very state being polled for) never resume.
        const at = cursor;
        setImmediate(() => {
          if (cursor === at) for (const c of st.poke) commands.send(c);
        });
      }
    } else if ('on' in st && st.on(ev)) {
      cursor++;
      if (st.send) fire(st.send);
      enterStep();
    }
  });
  enterStep();

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let halted = false;
  let failure: unknown;
  const task = run(function* () {
    yield* RunnerCtx.set(runner);
    yield* RerankerCtx.set(stubReranker);
    yield* spec.harness(ctx as unknown as SessionContext, bus, rawCommands);
  });
  spec.controls?.({
    halt: () => {
      halted = true;
      shutdownTraceIndex = trace.events.length;   // what follows is teardown, as it is after quit
      return task.halt();
    },
    send: (c) => commands.send(c),
    eventCount: () => events.length,
  });
  try {
    await Promise.race([
      // A task ended by `halt` rejects with "halted" when consumed; for the
      // scenario that asked for the halt, that is the run's normal end. A
      // one-shot run's own failure is the scenario's to inspect.
      task.catch((err: unknown) => {
        if (halted && err instanceof Error && err.message === 'halted') return;
        if (spec.oneshot !== undefined) { failure = err; return; }
        throw err;
      }),
      new Promise<never>((_, reject) => {
        // REF'd on purpose: a stalled scenario drains the event loop, and an
        // unref'd timer never fires on a drained loop — the hang was silent.
        watchdog = setTimeout(
          () => reject(new Error(`runHarness timed out — cursor at step ${cursor}/${steps.length}; last event: ${events[events.length - 1]?.type}`)),
          30_000,
        );
      }),
    ]);
  } catch (err) {
    // A timed-out run is still running: halt it so its fibers and context end with the scenario, not after.
    halted = true;
    if (shutdownTraceIndex < 0) shutdownTraceIndex = trace.events.length;
    await task.halt().catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(watchdog);
  }
  // A harness that returned on its own with steps still waiting did not run the scenario: an early exit must
  // not pass as a run that met every expectation. A halt and a one-shot failure are the scenario's own ends.
  if (!halted && failure === undefined && cursor < steps.length) {
    throw new Error(`runHarness: the harness returned with the script at step ${cursor}/${steps.length}; last event: ${events[events.length - 1]?.type}`);
  }

  return { events, trace: trace.events, outputDir, shutdownTraceIndex, halted, traceAt, ...(failure !== undefined ? { failure } : {}) };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ── Assertion helpers — the vocabulary scenarios speak ──

export const typesOf = (events: readonly { type: string }[]): string[] =>
  events.map((e) => e.type);

export type TraceLike = TraceEvent & {
  role?: string;
  speaker?: string;
  branchHandle?: number;
  content?: string;
};

/** The trunk's commits — one per turn the KV kept. */
export const warmDeltas = (trace: readonly TraceEvent[]): TraceLike[] =>
  (trace as TraceLike[]).filter(
    (t) => t.type === 'branch:prefill' && t.role === 'warmDelta',
  );

/** Prunes of a given handle — a trunk release when the handle committed turns. */
export const prunesOf = (trace: readonly TraceEvent[], handle: number): TraceLike[] =>
  (trace as TraceLike[]).filter(
    (t) => t.type === 'branch:prune' && t.branchHandle === handle,
  );

/** Releases of a handle DURING the session — shutdown's own dispose (which
 *  rightly releases the live trunk) doesn't count. */
export const sessionReleasesOf = (run: { trace: readonly TraceEvent[]; shutdownTraceIndex: number }, handle: number): TraceLike[] =>
  (run.trace as TraceLike[]).filter(
    (t, i) => t.type === 'branch:prune' && t.branchHandle === handle &&
      (run.shutdownTraceIndex < 0 || i < run.shutdownTraceIndex),
  );
