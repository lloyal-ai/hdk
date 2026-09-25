/**
 * The two boots — what a generated target entry is one call to.
 *
 * `bootEdge` runs the app in this process over one resident context: the
 * binding the environment picks — the `ipc` bridge when a desktop shell forked
 * this process, the app's terminal view on a TTY, JSON lines on a pipe — the
 * layered config, the install (what the model family names, acquired on first
 * run), the context, the services, the trace writer, the content store and
 * ingress, the edge Runner, and the app's `harness`. A one-shot run's
 * `HarnessExit` is its message on stderr and its code.
 *
 * `bootServed` serves N browser sessions over one resident model: one
 * `http.Server` carrying the content plane's bytes and a `WebSocketServer`
 * carrying references and state; each connection is a Session the host
 * admits, with its own context, services, trace and Runner, running the same
 * `harness`. A session that dies says why on the host's log.
 *
 * Both own the context they make: `initializeHarness` owns the session and
 * never the context, so the boot disposes it when its scope ends.
 *
 * @category Runtime
 */
import { main, call, createSignal, ensure, exit, suspend } from 'effection';
import type { Operation, Signal } from 'effection';
import { createServer } from 'node:http';
import * as os from 'node:os';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import type { SessionContext } from '@lloyal-labs/sdk';
import { Ingress, NSeqMax } from '@lloyal-labs/lloyal-agents';
import type { AbilityFactory } from './ability-types';
import { createBus } from '@lloyal-labs/binding';
import type { EventBus } from '@lloyal-labs/binding';
import { ipc, ndjson } from '@lloyal-labs/binding/node';
import type { Binding } from '@lloyal-labs/binding/node';
import { createContentIngress, MAX_DOCUMENT_BYTES, DOCUMENT_UPLOAD_TIMEOUT_MS } from '@lloyal-labs/media/node';
import type { ConfigTable, ConfigOf, ModelFamily, OriginOf } from './config';
import { loadYml, runnerConfig } from './config-layering';
import { bindServices, trunkOptions } from './provision';
import { install } from './install';
import type { Installed } from './install';
import { isInstallCommand } from './install-protocol';
import type { InstallCommand, InstallStepEvent } from './install-protocol';
import { useTraceWriter } from './trace-sink';
import { createProjectMediaStore } from './media-store';
import { createContentRoutes } from './content-routes';
import { makeEdgeRunner, makeServedRunner, RunnerCtx } from './runner';
import type { ConfigPatch } from './runner';
import { startHostResources } from './host-resources';
import { serveIngest } from './ingest-responder';
import { bufferedCommandSignal } from './buffered-command-signal';
import { prepareBackend, createResidentContext, DEFAULT_N_CTX, DEFAULT_N_SEQ_MAX } from './resident-context';
import { createServedHostDriver } from './served-host';
import type { OwnedConnection } from './served-host';
import { HarnessExit } from './harness-exit';

/** What a target entry hands a boot: the app as `app.ts` exports it. */
export interface HarnessApp<T extends ConfigTable, E, C> {
  harness(ctx: SessionContext, events: EventBus<E>, commands: Signal<C, void>): Operation<void>;
  abilities: readonly AbilityFactory[];
  config: T;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The layered config, or the process's end: a bad manifest fails before any model fetch or bind. */
function loadOrExit<T extends ConfigTable>(table: T, projectRoot: string, env: NodeJS.ProcessEnv) {
  try {
    return runnerConfig(table, loadYml(table, projectRoot), { env, cwd: projectRoot });
  } catch (err) {
    process.stderr.write(`${message(err)}\n`);
    process.exit(1);
  }
}

/** The install's progress on stderr — one line, rewritten in place while a step downloads, ended when it is over. */
function progressOnStderr(): (ev: InstallStepEvent) => void {
  let writing = false;
  return (ev) => {
    const running = ev.steps.find((step) => step.status === 'running' && step.total);
    if (running) {
      writing = true;
      process.stderr.write(`\rfetching ${running.id} — ${Math.round((100 * (running.got ?? 0)) / running.total!)}%   `);
    } else if (writing) {
      writing = false;
      process.stderr.write('\n');
    }
  };
}

export interface BootEdgeOpts<E, C> {
  /** Where `harness.yml` is — the project. Default: the process's cwd. */
  projectRoot?: string;
  /** The terminal view for a TTY: a render binding `(bus, dispatch, bootstrap) => dispose`. Without one a TTY gets JSON lines. */
  render?: Binding<E, C>;
  /** The process arguments to read `--query` from. Default: `process.argv`. */
  argv?: string[];
}

/**
 * Run the app in this process. `--query` runs scripted: a TTY auto-submits it
 * into the command loop; a bare pipe runs it one-shot to a settled report and
 * exits with the run's outcome.
 */
export function bootEdge<T extends ConfigTable, E, C>(app: HarnessApp<T, E, C>, opts: BootEdgeOpts<E, C> = {}): void {
  const projectRoot = opts.projectRoot ?? process.cwd();
  // Snapshotted before `prepareBackend` writes LLOYAL_GPU, so a re-layering after a save reads the operator's env.
  const bootEnv = { ...process.env };
  const { values: flags } = parseArgs({ args: (opts.argv ?? process.argv).slice(2), options: { query: { type: 'string' } }, strict: false });
  const initialQuery = typeof flags.query === 'string' ? flags.query : undefined;
  const bridged = !!process.env.RR_BRIDGE;
  const oneShot = !bridged && !process.stdout.isTTY;
  const loaded = loadOrExit(app.config, projectRoot, bootEnv);
  let model = loaded.config.model as ModelFamily;

  main(function* () {
    // The binding mounts FIRST — before the machine check, the fetch and the load. Nothing in a binding
    // touches the context, and mounting it last is what left a first run with no transport at all for the
    // minutes it spent downloading. The command loop still arms later; `bufferedCommandSignal` holds that gap.
    // The install's own commands are routed at this boundary, never by subscribing — a subscriber would
    // drain the harness's backlog.
    const dev = process.env.LLOYAL_DEV === '1';
    const events = createBus<E>();
    const commands = bufferedCommandSignal<C>();
    const installCommands = createSignal<InstallCommand, void>();
    const dispatch = (c: C): void => { if (isInstallCommand(c)) installCommands.send(c); else commands.send(c); };
    const bootstrap: E[] = [];
    const media = createProjectMediaStore(projectRoot);
    const ingress = createContentIngress(media);
    let dispose: () => void;
    if (bridged) {
      dispose = ipc<E, C>()(events, dispatch, bootstrap);
      yield* ensure(serveIngest(ingress));
    } else if (process.stdout.isTTY && opts.render) {
      dispose = opts.render(events, dispatch, bootstrap);
    } else {
      dispose = ndjson<E, C>()(events, dispatch, bootstrap);
    }
    yield* ensure(() => dispose());

    // A desktop shell has a view that can hold on a failed step and offer a remedy; a terminal or a pipe has
    // none, and a failure there ends the run with its reason.
    const progress = progressOnStderr();
    let acquired: Installed;
    try {
      acquired = yield* install({
        projectRoot, model, totalBytes: os.totalmem(),
        report: (ev) => { events.send(ev as unknown as E); progress(ev); },
        ...(bridged ? {
          controls: installCommands,
          persist: (patch) => loaded.persist!(patch as ConfigPatch<ConfigOf<T>>).config.model as ModelFamily,
        } : {}),
      });
    } catch (err) {
      process.stderr.write(`\n${message(err)}\n`);
      return yield* exit(1, message(err));
    }
    model = acquired.model;
    const llm = model.llm ?? {};

    const resident = { ...llm, path: acquired.llm, context: llm.context ?? DEFAULT_N_CTX };
    const cfg = { ...loaded.config, model: { ...model, llm: resident } } as ConfigOf<T>;
    prepareBackend(resident);
    const ctx = yield* call(() => createResidentContext(resident, trunkOptions(acquired.services, model)));
    yield* ensure(() => { try { ctx.dispose?.(); } catch { /* the context is gone either way */ } });
    yield* NSeqMax.set(resident.branches ?? DEFAULT_N_SEQ_MAX);
    yield* bindServices(acquired.services, model);

    const traceWriter = yield* useTraceWriter((cfg as { sources: { outputDir: string } }).sources.outputDir, dev, (ev) => events.send(ev as unknown as E));
    yield* RunnerCtx.set({
      ...makeEdgeRunner<ConfigOf<T>, OriginOf<T>>(cfg, {
        traceWriter, attachmentStore: media, dev,
        table: loaded.table, origin: loaded.origin, persist: loaded.persist, sessionOriginMap: loaded.sessionOriginMap, frozen: loaded.frozen,
      }),
      mode: oneShot ? 'oneshot' : 'interactive',
      initialQuery,
    });
    yield* Ingress.set(ingress);
    if (dev) yield* ensure(startHostResources((ev) => events.send(ev as unknown as E)));

    try {
      yield* app.harness(ctx, events, commands);
    } catch (err) {
      if (err instanceof HarnessExit) {
        // `process.exitCode` would be discarded here: Effection's `main` runs `exit(0)` when this body
        // returns, then hard-exits with THAT status. `exit` is its documented way out and unwinds every
        // `ensure` on the way — the resident context included, so the process still ends clean.
        yield* exit(err.exitCode, err.message);
      }
      throw err;
    }
  });
}

export interface BootServedOpts {
  projectRoot?: string;
  /** Named in the host's log line. */
  name?: string;
}

/**
 * How many browser sessions may be RESIDENT at once, when the box does not say.
 *
 * Resident, not working: a session holds its own context, reranker and projector
 * for as long as its socket is open, so a reader who settles a brief and leaves
 * the tab open still holds a slot and the next reader queues. Four is a cautious
 * number for one machine serving one model, not a measurement — size it against
 * the model, the context length and the vision configuration actually deployed,
 * with the sessions IDLE, and set `MAX_SESSIONS` on the box.
 *
 * The box's own settings — this, `PORT`, `HOST`, `LLOYAL_CONTENT_ORIGIN` — come
 * from the environment and nowhere else. They describe the machine, not the
 * harness, and one build serves many machines; a committed manifest would ship
 * one box's numbers to all of them. A second home here would also mean two
 * precedences for one value, which is the thing that makes "a validated cap"
 * unverifiable.
 */
export const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';   // no auth on the pilot: serving every interface is an explicit choice

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Serve N browser sessions over one resident model, until the process is signalled. */
export function bootServed<T extends ConfigTable, E, C>(app: HarnessApp<T, E, C>, opts: BootServedOpts = {}): void {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const bootEnv = { ...process.env };
  const loaded = loadOrExit(app.config, projectRoot, bootEnv);
  let model = loaded.config.model as ModelFamily;

  main(function* () {
    // Acquired once, before the host listens: there is no browser yet to hold for, so a failed step ends the
    // boot with its reason rather than at the port.
    let acquired: Installed;
    try {
      acquired = yield* install({ projectRoot, model, totalBytes: os.totalmem(), report: progressOnStderr() });
    } catch (err) {
      process.stderr.write(`\n${message(err)}\n`);
      return yield* exit(1, message(err));
    }
    model = acquired.model;
    const llm = model.llm ?? {};

    const resident = { ...llm, path: acquired.llm, context: llm.context ?? DEFAULT_N_CTX };
    const cfg = {
      ...loaded.config,
      model: { ...model, llm: resident, ...(acquired.services.reranker ? { reranker: { ...model.reranker, path: acquired.services.reranker } } : {}) },
    } as ConfigOf<T>;
    const port = envInt('PORT', DEFAULT_PORT);
    const maxNativeSessions = envInt('MAX_SESSIONS', DEFAULT_MAX_SESSIONS);
    const bindHost = process.env.HOST ?? DEFAULT_HOST;
    const dev = process.env.LLOYAL_DEV === '1';

    // ONE content store for the whole host: sessions share it, and the index has a single writer.
    const media = createProjectMediaStore(projectRoot);
    const ingress = createContentIngress(media);

    const driver = yield* createServedHostDriver<E, C>({
      maxNativeSessions,
      buildContext: () => createResidentContext(resident, trunkOptions(acquired.services, model)),
      *run(m) {
        prepareBackend(resident);
        yield* NSeqMax.set(resident.branches ?? DEFAULT_N_SEQ_MAX);
        // Per session, off the artifacts the boot already acquired: each session binds its own instances,
        // they live as long as it does, and one session's failure to bind is its own death, not the host's.
        yield* bindServices(acquired.services, model);
        if (dev) yield* ensure(startHostResources((ev) => m.uiChannel.send(ev as unknown as E)));
        const traceWriter = yield* useTraceWriter((cfg as { sources: { outputDir: string } }).sources.outputDir, dev, (ev) => m.uiChannel.send(ev as unknown as E));
        yield* RunnerCtx.set(makeServedRunner<ConfigOf<T>, OriginOf<T>>(cfg, {
          traceWriter, attachmentStore: media, dev,
          table: loaded.table, origin: loaded.origin, sessionOriginMap: loaded.sessionOriginMap, frozen: loaded.frozen,
        }));
        yield* Ingress.set(ingress);
        yield* app.harness(m.context, m.uiChannel, m.commands);
      },
    });

    // ONE http.Server, two planes on it: HTTP carries BYTES, the WebSocket carries REFERENCES and state.
    const content = createContentRoutes({
      store: media,
      ingest: (bytes, signal) => ingress.ingest(bytes, signal),
      maxUploadBytes: MAX_DOCUMENT_BYTES,
      uploadTimeoutMs: DOCUMENT_UPLOAD_TIMEOUT_MS,
      ...(process.env.LLOYAL_CONTENT_ORIGIN ? { allowedOrigin: process.env.LLOYAL_CONTENT_ORIGIN } : {}),
    });
    const http = createServer((req, res) => {
      try {
        if (content(req, res)) return;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    const server = new WebSocketServer({ server: http });
    http.on('error', (err: NodeJS.ErrnoException) => {
      console.error(`[serve] failed to bind ${bindHost}:${port} — ${err.code ?? err.message}`);
      process.exit(1);
    });
    http.on('clientError', (_err, socket) => socket.destroy());
    http.listen(port, bindHost);
    server.on('connection', (socket) => driver.serveConnection(socket as unknown as OwnedConnection));
    console.log(
      `\n${opts.name ?? 'harness'} serving on ws://${bindHost}:${port}` +
      ` — up to ${maxNativeSessions} resident browser session(s), ${resident.branches ?? DEFAULT_N_SEQ_MAX} branches each` +
      `\n  ${resident.path}`,
    );

    yield* suspend();
  });
}
