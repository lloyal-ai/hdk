/**
 * The two boots — what a generated target entry is one call to.
 *
 * `bootEdge` runs the app in this process over one resident context: the
 * layered config, the models resolved (fetched on first run), the context,
 * the abilities' services, the trace writer, the content store and ingress,
 * the edge Runner, the binding the environment picks — the `ipc` bridge when a
 * desktop shell forked this process, the app's terminal view on a TTY, JSON
 * lines on a pipe — and the app's `harness`. A one-shot run's `HarnessExit` is
 * its message on stderr and its code.
 *
 * `bootServed` serves N browser sessions over one resident model: one
 * `http.Server` carrying the content plane's bytes and a `WebSocketServer`
 * carrying references and state; each connection is a Session the host
 * admits, with its own context, reranker, trace and Runner, running the same
 * `harness`. A session that dies says why on the host's log.
 *
 * Both own the context they make: `initializeHarness` owns the session and
 * never the context, so the boot disposes it when its scope ends.
 *
 * @category Runtime
 */
import { main, call, ensure, exit, suspend } from 'effection';
import type { Operation, Signal } from 'effection';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import type { SessionContext } from '@lloyal-labs/sdk';
import { Ingress, NSeqMax } from '@lloyal-labs/lloyal-agents';
import type { AbilityFactory } from '@lloyal-labs/lloyal-agents';
import { createBus } from '@lloyal-labs/binding';
import type { EventBus } from '@lloyal-labs/binding';
import { ipc, ndjson } from '@lloyal-labs/binding/node';
import type { Binding, WsServerSocket } from '@lloyal-labs/binding/node';
import { createContentIngress, MAX_DOCUMENT_BYTES, DOCUMENT_UPLOAD_TIMEOUT_MS } from '@lloyal-labs/media/node';
import type { ConfigTable, ConfigOf, OriginOf } from './config';
import { loadYml, runnerConfig } from './config-layering';
import { resolveModel, resolveRuntimeModels } from './models';
import type { ModelRole } from './models';
import { provisionAbilityModels } from './provision';
import { useTraceWriter } from './trace-sink';
import { createProjectMediaStore } from './media-store';
import { createContentRoutes } from './content-routes';
import { makeEdgeRunner, makeServedRunner, RunnerCtx } from './runner';
import { startHostResources } from './host-resources';
import { serveIngest } from './ingest-responder';
import { bufferedCommandSignal } from './buffered-command-signal';
import { applyGpuEnv, createResidentContext, DEFAULT_N_CTX, DEFAULT_N_SEQ_MAX } from './resident-context';
import { createServedHostDriver } from './served-host';
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

const progress = (label: string) => (got: number, total: number): void => {
  process.stderr.write(`\rfetching ${label} — ${total > 0 ? Math.round((100 * got) / total) : 0}%   `);
};

type ModelBlock = ConfigOf<ConfigTable>['model'] & {
  path?: string; nCtx?: number; branches?: number; kvCache?: string; gpu?: string;
  imageMinTokens?: number; imageMaxTokens?: number; reranker?: string; rerankerId?: string; id?: string; mmproj?: string;
};

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
  // Snapshotted before `applyGpuEnv` writes LLOYAL_GPU, so a re-layering after a save reads the operator's env.
  const bootEnv = { ...process.env };
  const { values: flags } = parseArgs({ args: (opts.argv ?? process.argv).slice(2), options: { query: { type: 'string' } }, strict: false });
  const initialQuery = typeof flags.query === 'string' ? flags.query : undefined;
  const bridged = !!process.env.RR_BRIDGE;
  const oneShot = !bridged && !process.stdout.isTTY;
  const loaded = loadOrExit(app.config, projectRoot, bootEnv);
  const model = loaded.config.model as ModelBlock;

  main(function* () {
    let modelPath: string;
    let mmprojPath: string | undefined;
    let fetching = false;
    try {
      const models = yield* call(() =>
        resolveRuntimeModels({
          projectRoot, config: model, llmId: model.id,
          onProgress: (role: ModelRole, got, total) => { fetching = true; progress(role)(got, total); },
        }),
      );
      modelPath = models.modelPath;
      mmprojPath = models.mmprojPath;
    } catch (err) {
      process.stderr.write(`\n${message(err)}\n`);
      process.exit(1);
    }
    if (fetching) process.stderr.write('\n');

    const nCtx = model.nCtx ?? DEFAULT_N_CTX;
    const cfg = { ...loaded.config, model: { ...model, path: modelPath, nCtx } } as ConfigOf<T>;
    applyGpuEnv(model);
    const ctx = yield* call(() => createResidentContext({ ...model, path: modelPath, nCtx }, mmprojPath));
    yield* ensure(() => { try { ctx.dispose?.(); } catch { /* the context is gone either way */ } });
    yield* NSeqMax.set(model.branches ?? DEFAULT_N_SEQ_MAX);

    let fetchingReranker = false;
    try {
      yield* provisionAbilityModels({
        abilities: app.abilities, projectRoot,
        reranker: model.reranker ? { path: model.reranker } : model.rerankerId ? { id: model.rerankerId } : undefined,
        rerankerLoad: { nSeqMax: 10, nCtx: 16384 },
        onProgress: (got, total) => { fetchingReranker = true; progress('reranker')(got, total); },
      });
    } catch (err) {
      process.stderr.write(`\n${message(err)}\n`);
      process.exit(1);
    }
    if (fetchingReranker) process.stderr.write('\n');

    const dev = process.env.LLOYAL_DEV === '1';
    const events = createBus<E>();
    const traceWriter = yield* useTraceWriter((cfg as { sources: { outputDir: string } }).sources.outputDir, dev, (ev) => events.send(ev as unknown as E));
    const media = createProjectMediaStore(projectRoot);
    const ingress = createContentIngress(media);
    yield* RunnerCtx.set({
      ...makeEdgeRunner<ConfigOf<T>, OriginOf<T>>(cfg, {
        traceWriter, attachmentStore: media, dev,
        origin: loaded.origin, persist: loaded.persist, sessionOriginMap: loaded.sessionOriginMap, frozen: loaded.frozen,
      }),
      mode: oneShot ? 'oneshot' : 'interactive',
      initialQuery,
    });
    yield* Ingress.set(ingress);

    // Buffered: the binding dispatches from the moment it mounts; the command loop arms after boot.
    const commands = bufferedCommandSignal<C>();
    const dispatch = (c: C): void => { commands.send(c); };
    const bootstrap: E[] = [];
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
  /** Default: `PORT`, else 8787. */
  port?: number;
  /** Default: `HOST`, else loopback — the pilot is no-auth, so an all-interfaces bind is an explicit opt-in. */
  host?: string;
  /** Default: `MAX_SESSIONS`, else 8. */
  maxSessions?: number;
  /** Named in the host's log line. */
  name?: string;
}

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
  const model = loaded.config.model as ModelBlock;

  main(function* () {
    const models = yield* call(() =>
      resolveRuntimeModels({ projectRoot, config: model, llmId: model.id, onProgress: (role: ModelRole, g, t) => progress(role)(g, t) }),
    );
    const rerankerPath = yield* call(() =>
      resolveModel({
        projectRoot, role: 'reranker',
        spec: model.reranker ? { path: model.reranker } : { id: model.rerankerId },
        onProgress: progress('reranker'),
      }),
    );
    const resident = { ...model, path: models.modelPath, reranker: rerankerPath, nCtx: model.nCtx ?? DEFAULT_N_CTX };
    const cfg = { ...loaded.config, model: resident } as ConfigOf<T>;
    const port = opts.port ?? envInt('PORT', 8787);
    const maxNativeSessions = opts.maxSessions ?? envInt('MAX_SESSIONS', 8);
    const bindHost = opts.host ?? process.env.HOST ?? '127.0.0.1';
    const dev = process.env.LLOYAL_DEV === '1';

    // ONE content store for the whole host: sessions share it, and the index has a single writer.
    const media = createProjectMediaStore(projectRoot);
    const ingress = createContentIngress(media);

    const driver = yield* createServedHostDriver<E, C>({
      maxNativeSessions,
      buildContext: () => createResidentContext(resident, models.mmprojPath),
      *run(m) {
        applyGpuEnv(resident);
        yield* NSeqMax.set(resident.branches ?? DEFAULT_N_SEQ_MAX);
        yield* provisionAbilityModels({
          abilities: app.abilities, projectRoot,
          reranker: { path: rerankerPath },
          rerankerLoad: { nSeqMax: 10, nCtx: 16384 },
        });
        if (dev) yield* ensure(startHostResources((ev) => m.uiChannel.send(ev as unknown as E)));
        const traceWriter = yield* useTraceWriter((cfg as { sources: { outputDir: string } }).sources.outputDir, dev, (ev) => m.uiChannel.send(ev as unknown as E));
        yield* RunnerCtx.set(makeServedRunner<ConfigOf<T>, OriginOf<T>>(cfg, {
          traceWriter, attachmentStore: media, dev,
          origin: loaded.origin, sessionOriginMap: loaded.sessionOriginMap, frozen: loaded.frozen,
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
    server.on('connection', (socket) => driver.serveConnection(socket as unknown as WsServerSocket));
    console.log(`\n${opts.name ?? 'harness'} serving on ws://${bindHost}:${port} — up to ${maxNativeSessions} browser session(s) over ${resident.path}`);

    yield* suspend();
  });
}
