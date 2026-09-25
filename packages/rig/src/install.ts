/**
 * Acquiring what a run needs before it can work, reported step by step.
 *
 * INSTALL IS NOT BOOT. Install acquires bytes a machine does not have yet, so it happens on a
 * first run and then never again; boot loads bytes already on disk, and happens every start.
 * A run that acquires nothing reports nothing and simply opens.
 *
 * The steps are DERIVED: the machine, the reasoning model, the vision projector when its block
 * is present, then every service the configuration names — each one a provider,
 * never a list a view or a boot maintains. A step is satisfied by a spec (the block's `path`,
 * else its `id`, else the row's derivation), and acquiring it is `resolveModel`'s walk. So the
 * two remedies are one mechanism: retry re-resolves the step, and a file the reader already has
 * adds a spec and re-resolves it — remembered for the next launch through the runner's own
 * persistence. A step failing holds the run where a view can offer those remedies, and ends it
 * where none can.
 *
 * Node-only. Import from `@lloyal-labs/rig/node`.
 *
 * @category Runtime
 */
import { call, each, scoped, spawn } from 'effection';
import type { Operation, Stream } from 'effection';
import { SERVICES } from './services';
import type { Service } from './services';
import { modelSettings } from './config';
import type { ModelFamily } from './config';
import type { BaseHarnessConfig, ConfigPatch } from './runner';
import { checkMachine, gb, refusalMessage } from './machine';
import { carryOverVisionSlot, catalogEntry, isModelPresent, resolveModel } from './models';
import type { ModelCatalogEntry, ModelRole, ModelSpec } from './models';
import { configuredServices, specOf } from './provision';
import type { ServiceArtifacts } from './provision';
import type { InstallCommand, InstallStep, InstallStepEvent } from './install-protocol';

/** A step with what acquires it: the slot it fills and the spec that satisfies it. The machine step has neither. */
export interface PlannedStep extends InstallStep {
  role?: ModelRole;
  spec?: ModelSpec;
}

/** Whether a step's block takes a `path` — the one condition under which a file the reader already has can stand in. */
const takesFile = (id: string): boolean => `model.${id}.path` in modelSettings;

/**
 * The steps this run performs, in order, from the model family alone: the machine, the reasoning model, then
 * every service whose block is present, each with its spec. A block that selects nothing it can — a
 * `reranker: {}`, a vision block under a `path:` llm — is refused here, before anything runs. A step's label
 * is framework words: the model, and each service's model by the service's name.
 */
export function planInstall(model: ModelFamily): PlannedStep[] {
  const llm = model.llm ?? {};
  const steps: PlannedStep[] = [
    { id: 'machine', label: 'This machine', status: 'pending' },
    { id: 'llm', label: 'Getting the model', status: 'pending', role: 'llm', file: takesFile('llm'), ...(llm.path || llm.id ? { spec: llm.path ? { path: llm.path } : { id: llm.id } } : {}) },
  ];
  for (const name of configuredServices(model)) {
    steps.push({ id: name, label: `Getting the ${name} model`, status: 'pending', role: name, file: takesFile(name), spec: specOf(name, model) });
  }
  return steps;
}

/** Whether a step moves bytes: a catalog id not yet in its slot. A `path`, or a slot to adopt from, is already here. */
const fetches = (projectRoot: string, step: PlannedStep): boolean =>
  step.role !== undefined && step.spec?.id !== undefined && !isModelPresent(projectRoot, step.role, step.spec.id);

export interface InstallOpts {
  projectRoot: string;
  model: ModelFamily;
  /** The box's total memory, for the machine step. */
  totalBytes: number;
  /** Where each snapshot goes — the harness's channel, where a view can see it. */
  report: (ev: InstallStepEvent) => void;
  /** The install commands a view sends, where a view can: absent, a failed step ends the run. */
  controls?: Stream<InstallCommand, void>;
  /** How a chosen file is remembered for the next launch — the runner's own persistence, handed the patch a
   *  save takes — answering the re-layered model family. Required beside `controls`. */
  persist?: (patch: ConfigPatch<BaseHarnessConfig>) => ModelFamily;
  fetchImpl?: typeof fetch;
  /** Where a one-time note goes. Default: stderr. */
  say?: (line: string) => void;
}

/** What the install acquired: the reasoning model, every service's artifact, and the model family as it now stands. */
export interface Installed {
  model: ModelFamily;
  llm: string;
  services: ServiceArtifacts;
}

/** One attempt at a step: the artifact, or the command that interrupted it, or the failure. */
type Attempt = { artifact: string } | { command: InstallCommand } | { error: unknown };

/**
 * Acquire everything the model family names. Nothing is fetched before the machine is checked; nothing is
 * loaded here at all. Throws when the run cannot proceed — the machine refused, a step failed with no view
 * to hold for, the reader stopped it — with the message the boot ends on.
 */
export function* install(opts: InstallOpts): Operation<Installed> {
  let model = opts.model;
  const steps = planInstall(model);
  const say = opts.say ?? ((line: string): void => { process.stderr.write(`${line}\n`); });
  let announced = false;
  const send = (): void => opts.report({ type: 'install:step', steps: steps.map(({ role: _r, spec: _s, ...step }) => ({ ...step })) });
  const set = (step: PlannedStep, patch: Partial<InstallStep>): void => {
    Object.assign(step, patch);
    if (announced) send();
  };

  // The machine, before a byte is fetched — and on every start, since weights carried onto a box too small for
  // them fail as hard as ones downloaded onto it. A model with no class is trusted by possession.
  const [machine, llmStep] = steps;
  const entry: ModelCatalogEntry | undefined = llmStep.spec?.id ? catalogEntry('llm', llmStep.spec.id) : undefined;
  const verdict = entry ? checkMachine(entry, opts.totalBytes) : null;
  if (verdict) machine.note = `${gb(verdict.totalBytes)} · ${gb(verdict.neededBytes)} needed`;
  if (verdict && !verdict.ok) {
    machine.status = 'failed';
    announced = true;
    send();
    throw new Error(refusalMessage(verdict, entry!.label));
  }
  machine.status = 'done';
  if (steps.some((step) => fetches(opts.projectRoot, step))) {
    announced = true;
    send();
  }

  // A slot from before the role was named for its service is carried over once, before the walk — a migration
  // with a sunset: every project scaffolded since cut 10 has the new slot, so this goes with the cut after next.
  carryOverVisionSlot(opts.projectRoot, say);

  const artifacts: Record<string, string> = {};
  for (const step of steps.slice(1)) {
    for (;;) {
      set(step, { status: 'running', got: undefined, total: undefined, note: undefined });
      const attempt = yield* attemptStep(step, opts, (got, total) => set(step, { got, total }));
      if ('artifact' in attempt) {
        artifacts[step.id] = attempt.artifact;
        set(step, { status: 'done', got: undefined, total: undefined, ...(step.spec?.id ? { note: catalogEntry(step.role!, step.spec.id)?.label ?? step.spec.id } : {}) });
        break;
      }
      let command: InstallCommand;
      if ('command' in attempt) {
        command = attempt.command;
      } else {
        set(step, { status: 'failed', note: attempt.error instanceof Error ? attempt.error.message : String(attempt.error) });
        if (!opts.controls) throw attempt.error;
        command = yield* nextCommand(opts.controls);
      }
      if (command.type === 'install:quit') throw new Error('the install was stopped');
      if (command.type === 'install:use_file') {
        if (!opts.persist) throw new Error('install: a file was chosen, but nothing here can remember it — `persist` is required beside `controls`');
        model = opts.persist({ model: { [command.step]: { path: command.path } } });
        const target = steps.find((s) => s.id === command.step);
        if (target) target.spec = { path: command.path };
      }
      // A retry, or a file for this or another step: this step runs again from its spec as it now stands.
    }
  }

  if (announced) {
    steps.length = 0;
    send();
  }
  const services: ServiceArtifacts = {};
  for (const name of SERVICES) if (artifacts[name] !== undefined) services[name as Service] = artifacts[name];
  return { model, llm: artifacts.llm!, services };
}

/** Run one step under its controls: a command that arrives while it downloads stops the download and is the outcome. */
function attemptStep(step: PlannedStep, opts: InstallOpts, onProgress: (got: number, total: number) => void): Operation<Attempt> {
  return scoped(function* () {
    const controller = new AbortController();
    let command: InstallCommand | undefined;
    if (opts.controls) {
      const controls = opts.controls;
      yield* spawn(function* () {
        for (const c of yield* each(controls)) {
          command = c;
          controller.abort();
          yield* each.next();
        }
      });
    }
    try {
      const artifact = yield* call(() =>
        resolveModel({
          projectRoot: opts.projectRoot,
          role: step.role!,
          spec: step.spec,
          onProgress,
          signal: controller.signal,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        }),
      );
      return command ? { command } : { artifact };
    } catch (error) {
      return command ? { command } : { error };
    }
  });
}

/** Hold for the reader's next command. */
function* nextCommand(controls: Stream<InstallCommand, void>): Operation<InstallCommand> {
  const subscription = yield* controls;
  const next = yield* subscription.next();
  if (next.done) throw new Error('the install was stopped');
  return next.value;
}
