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
import { main, call, ensure, exit, sleep, suspend } from 'effection';
import type { Operation, Signal } from 'effection';
import * as os from 'node:os';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import type { SessionContext } from '@lloyal-labs/sdk';
import { Ingress, NSeqMax } from '@lloyal-labs/lloyal-agents';
import type { AbilityFactory, Service } from '@lloyal-labs/lloyal-agents';
import { createBus } from '@lloyal-labs/binding';
import type { EventBus } from '@lloyal-labs/binding';
import { ipc, ndjson } from '@lloyal-labs/binding/node';
import type { Binding } from '@lloyal-labs/binding/node';
import { createContentIngress, MAX_DOCUMENT_BYTES, DOCUMENT_UPLOAD_TIMEOUT_MS } from '@lloyal-labs/media/node';
import type { ConfigTable, ConfigOf, OriginOf } from './config';
import { loadYml, runnerConfig } from './config-layering';
import { catalogEntry, isModelPresent, resolveRuntimeModels } from './models';
import type { ModelRole, ModelSpec, RuntimeModels } from './models';
import { checkMachine, gb, installReporter, mockInstallFrames, planSteps, refusalMessage, rerankerStep } from './install';
import type { InstallStep, InstallStepEvent, InstallStepId } from './install';
import { declaredServices, provisionAbilityModels, resolveAbilityModels } from './provision';
import type { AbilityModels } from './provision';
import { useTraceWriter } from './trace-sink';
import { createProjectMediaStore } from './media-store';
import { createContentRoutes } from './content-routes';
import { makeEdgeRunner, makeServedRunner, RunnerCtx } from './runner';
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
  /**
   * Auxiliary services THIS harness's own code consumes, beside whatever its
   * abilities declare.
   *
   * Same vocabulary, same rule: a consumer declares the capability, and
   * `harness.yml` names only which model backs it. An ability declares in its
   * manifest; a harness declares here, because a harness is a consumer too — it
   * owns the protocol that accepts an image, and it can read `RerankerCtx`
   * directly without any ability involved.
   *
   * Absent means this harness needs none of its own. It does not mean none are
   * provisioned: an ability that declares one still gets it.
   */
  services?: readonly Service[];
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

/** The model an operator named for an auxiliary service — which model, never whether:
 *  what a service is needed for is the abilities' to declare, in both boots. */
const rerankerSpec = (m: ModelBlock): ModelSpec | undefined =>
  m.reranker ? { path: m.reranker } : m.rerankerId ? { id: m.rerankerId } : undefined;

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
  const model = loaded.config.model as ModelBlock;

  main(function* () {
    // The binding mounts FIRST — before the machine check, the fetch and the
    // load. Nothing in a binding touches the context (each takes `(bus,
    // dispatch, bootstrap)`), and mounting it last is what left a first run with
    // no transport at all for the minutes it spent downloading. The command loop
    // still arms later; `bufferedCommandSignal` exists for exactly that gap.
    const dev = process.env.LLOYAL_DEV === '1';
    const events = createBus<E>();
    const commands = bufferedCommandSignal<C>();
    const dispatch = (c: C): void => { commands.send(c); };
    const bootstrap: E[] = [];
    // ONE content store for this process. Neither it nor the ingress reads the
    // model, so both come up with the transport rather than behind it.
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

    // Everything this run consumes, over both kinds of consumer — the abilities'
    // manifests and this harness's own declaration. Asked once, before anything
    // is fetched, so the installer can draw the whole list and the resolver
    // fetches only what something asked for.
    const wants = declaredServices(app.abilities, app.services);

    // ── what this run must acquire, decided before it acquires anything ──
    //
    // INSTALL IS NOT BOOT. A run that already has its weights shows no installer
    // at all; it only loads, which every run does. Presence is the same question
    // `resolveModel` asks, through the same derivation, so the two cannot drift.
    const entry = model.path || !model.id ? undefined : catalogEntry('llm', model.id);
    const mmprojId = wants.has('vision')
      ? model.mmproj ?? (model.path ? undefined : entry?.mmproj)
      : undefined;
    const needsModel = !model.path && !!model.id && !isModelPresent(projectRoot, 'llm', model.id);
    const needsProjector = !!mmprojId && !isModelPresent(projectRoot, 'mmproj', mmprojId);
    const installing = needsModel || needsProjector;

    const steps: InstallStep[] = planSteps({ projector: needsProjector });
    const report = installReporter((ev: InstallStepEvent) => { events.send(ev as unknown as E); }, steps);
    if (installing) report.announce();

    // ── the machine check, before a single byte is fetched ──
    //
    // Runs whether or not anything is being installed: weights carried onto a
    // machine too small to hold them fail just as hard as ones downloaded onto
    // it. A model with no class — a `path:` override, a hand-dropped weight — is
    // trusted by possession and not gated.
    const verdict = entry ? checkMachine(entry, os.totalmem()) : null;
    if (verdict) {
      report.set('machine', {
        status: verdict.ok ? 'done' : 'failed',
        note: `${gb(verdict.totalBytes)} · ${gb(verdict.neededBytes)} needed`,
      });
      if (!verdict.ok) {
        const why = refusalMessage(verdict, entry?.label ?? String(model.id));
        process.stderr.write(`\n${why}\n`);
        // Effection's exit, not process.exit: it unwinds every `ensure` on the
        // way out, which gives the binding its turn to carry the failed step to
        // a view before the process is gone.
        yield* exit(1, why);
      }
    }

    // ── LLOYAL_MOCK_INSTALL=<seconds>: the screen, without the download ──
    //
    // Only where there is nothing to acquire, which is the point: the weights
    // are already here, so the steps are replayed at their REAL sizes and the
    // boot then proceeds normally. `resolveModel` and `fetchVerified` are not
    // mocked — they are simply not reached — so no test path can drift from the
    // real one. It says so on stderr, because a fake that stays quiet is how a
    // fake gets mistaken for the thing.
    const mockSeconds = Number(process.env.LLOYAL_MOCK_INSTALL);
    if (Number.isFinite(mockSeconds) && mockSeconds > 0 && !installing && entry) {
      const sizeOf = (id: InstallStepId): number =>
        id === 'projector' ? (mmprojId ? catalogEntry('mmproj', mmprojId)?.sizeBytes ?? 0 : 0) : entry.sizeBytes;
      const mock = planSteps({ projector: !!mmprojId });
      const mockReport = installReporter((ev: InstallStepEvent) => { events.send(ev as unknown as E); }, mock);
      process.stderr.write(`\nLLOYAL_MOCK_INSTALL=${mockSeconds} — replaying the install screen; nothing is downloaded.\n`);
      mockReport.set('machine', {
        status: 'done',
        note: verdict ? `${gb(verdict.totalBytes)} · ${gb(verdict.neededBytes)} needed` : undefined,
      });
      for (const frame of mockInstallFrames(mock, sizeOf, mockSeconds)) {
        mockReport.set(frame.id, { status: 'running', got: frame.got, total: frame.total });
        yield* sleep(frame.afterMs);
      }
      for (const step of mock) if (step.id !== 'machine') mockReport.set(step.id, { status: 'done' });
      // Cleared so the view leaves the installer and the app opens, exactly as
      // it does when a real install finishes.
      mockReport.clear();
    }

    let modelPath: string;
    let mmprojPath: string | undefined;
    let fetching = false;
    try {
      const models = yield* call(() =>
        resolveRuntimeModels({
          projectRoot, config: model, llmId: model.id, vision: wants.has('vision'),
          onProgress: (role: ModelRole, got, total) => {
            fetching = true;
            progress(role)(got, total);
            report.set(role === 'mmproj' ? 'projector' : 'model', { status: 'running', got, total });
          },
        }),
      );
      modelPath = models.modelPath;
      mmprojPath = models.mmprojPath;
    } catch (err) {
      report.set(needsProjector && !needsModel ? 'projector' : 'model', { status: 'failed', note: message(err) });
      process.stderr.write(`\n${message(err)}\n`);
      process.exit(1);
    }
    if (fetching) process.stderr.write('\n');
    if (needsModel) report.set('model', { status: 'done', note: entry?.label });
    if (needsProjector) report.set('projector', { status: 'done' });

    const nCtx = model.nCtx ?? DEFAULT_N_CTX;
    const cfg = { ...loaded.config, model: { ...model, path: modelPath, nCtx } } as ConfigOf<T>;
    prepareBackend(model);
    const ctx = yield* call(() => createResidentContext({ ...model, path: modelPath, nCtx }, mmprojPath));
    yield* ensure(() => { try { ctx.dispose?.(); } catch { /* the context is gone either way */ } });
    yield* NSeqMax.set(model.branches ?? DEFAULT_N_SEQ_MAX);

    let fetchingReranker = false;
    try {
      yield* provisionAbilityModels({
        abilities: app.abilities, projectRoot, services: app.services,
        reranker: rerankerSpec(model),
        rerankerLoad: { nSeqMax: 10, nCtx: 16384 },
        onProgress: (got, total) => {
          // Appended on its first byte, never planned: whether a harness needs a
          // reranker is its abilities' to declare, and that is answered here.
          if (!fetchingReranker) report.add(rerankerStep());
          fetchingReranker = true;
          progress('reranker')(got, total);
          report.set('reranker', { status: 'running', got, total });
        },
      });
    } catch (err) {
      if (fetchingReranker) report.set('reranker', { status: 'failed', note: message(err) });
      process.stderr.write(`\n${message(err)}\n`);
      process.exit(1);
    }
    if (fetchingReranker) {
      process.stderr.write('\n');
      report.set('reranker', { status: 'done' });
    }
    // Everything this run had to acquire is acquired. The installer goes; what
    // remains is boot, which every run does and which the app shows in its own
    // shell. Steps left standing at `done` would hold a finished screen in front
    // of a working app.
    if (installing) report.clear();

    const traceWriter = yield* useTraceWriter((cfg as { sources: { outputDir: string } }).sources.outputDir, dev, (ev) => events.send(ev as unknown as E));
    yield* RunnerCtx.set({
      ...makeEdgeRunner<ConfigOf<T>, OriginOf<T>>(cfg, {
        traceWriter, attachmentStore: media, dev,
        origin: loaded.origin, persist: loaded.persist, sessionOriginMap: loaded.sessionOriginMap, frozen: loaded.frozen,
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
  const model = loaded.config.model as ModelBlock;

  main(function* () {
    let models: RuntimeModels;
    let aux: AbilityModels;
    let fetching = false;
    try {
      models = yield* call(() =>
        resolveRuntimeModels({
          projectRoot, config: model, llmId: model.id,
          vision: declaredServices(app.abilities, app.services).has('vision'),
          onProgress: (role: ModelRole, g, t) => { fetching = true; progress(role)(g, t); },
        }),
      );
      // The auxiliary services are the installed abilities' to declare — the same
      // question the edge boot asks. A host whose abilities need no reranker fetches
      // none; one that does fails HERE, with its reason, rather than at the port.
      aux = yield* resolveAbilityModels({
        abilities: app.abilities, projectRoot, services: app.services,
        reranker: rerankerSpec(model),
        onProgress: (g, t) => { fetching = true; progress('reranker')(g, t); },
      });
    } catch (err) {
      process.stderr.write(`\n${message(err)}\n`);
      process.exit(1);
    }
    if (fetching) process.stderr.write('\n');

    const resident = {
      ...model, path: models.modelPath, nCtx: model.nCtx ?? DEFAULT_N_CTX,
      ...(aux.reranker ? { reranker: aux.reranker } : {}),
    };
    const cfg = { ...loaded.config, model: resident } as ConfigOf<T>;
    const port = envInt('PORT', DEFAULT_PORT);
    const maxNativeSessions = envInt('MAX_SESSIONS', DEFAULT_MAX_SESSIONS);
    const bindHost = process.env.HOST ?? DEFAULT_HOST;
    const dev = process.env.LLOYAL_DEV === '1';

    // ONE content store for the whole host: sessions share it, and the index has a single writer.
    const media = createProjectMediaStore(projectRoot);
    const ingress = createContentIngress(media);

    const driver = yield* createServedHostDriver<E, C>({
      maxNativeSessions,
      buildContext: () => createResidentContext(resident, models.mmprojPath),
      *run(m) {
        prepareBackend(resident);
        yield* NSeqMax.set(resident.branches ?? DEFAULT_N_SEQ_MAX);
        // Per session, off the paths the boot already fetched: the requirement is
        // read again from the same abilities, so nothing loads that nothing asked for.
        yield* provisionAbilityModels({
          abilities: app.abilities, projectRoot, services: app.services,
          reranker: aux.reranker ? { path: aux.reranker } : undefined,
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
    server.on('connection', (socket) => driver.serveConnection(socket as unknown as OwnedConnection));
    console.log(
      `\n${opts.name ?? 'harness'} serving on ws://${bindHost}:${port}` +
      ` — up to ${maxNativeSessions} resident browser session(s), ${resident.branches ?? DEFAULT_N_SEQ_MAX} branches each` +
      `\n  ${resident.path}`,
    );

    yield* suspend();
  });
}
