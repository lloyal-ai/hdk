/**
 * Acquiring what a run needs before it can work, reported step by step.
 *
 * INSTALL IS NOT BOOT. Install acquires bytes a machine does not have yet, so it happens on a
 * first run and then never again; boot loads bytes already on disk, and happens every start.
 * A run that acquires nothing, and fails at nothing, reports nothing and simply opens.
 *
 * The steps are DERIVED: the machine, the reasoning model, then every service the configuration
 * names — each one a provider, never a list a view or a boot maintains. `planInstall` is the ONE
 * derivation, and the walk never edits a step by hand: when a file the reader already has changes
 * the configuration, the steps are derived again from what was persisted and reconciled against
 * what was already done, so the artifacts a run ends with can never disagree with its manifest.
 * A step is satisfied by a spec (the block's `path`, else its `id`, else the provider's
 * derivation), and acquiring it is `resolveModel`'s walk. Retry re-resolves the step; a file adds
 * a spec and re-derives. A step failing holds the run where a view can offer those remedies, and
 * ends it where none can — and either way its row is published, whether or not any download was
 * ever expected.
 *
 * Node-only. Import from `@lloyal-labs/rig/node`.
 *
 * @category Runtime
 */
import { call, each, scoped, spawn } from 'effection';
import type { Operation, Stream } from 'effection';
import { modelSettings } from './config';
import type { ModelFamily } from './config';
import type { BaseHarnessConfig, ConfigPatch } from './runner';
import { checkMachine, gb, refusalMessage } from './machine';
import { carryOverVisionSlot, catalogEntry, isModelPresent, resolveModel } from './models';
import type { ModelCatalogEntry, ModelRole, ModelSpec } from './models';
import { configuredServices, specOf } from './provision';
import type { ServiceArtifacts } from './provision';
import { SERVICES } from './services';
import type { Service } from './services';
import type { InstallCommand, InstallStep, InstallStepEvent } from './install-protocol';

/** A step with what acquires it: the slot it fills and the spec that satisfies it. The machine step has neither.
 *  `refused` is a step whose block selects nothing it can — carried as the step's failure until a file gives it
 *  a spec, and never resolved, because a slot may still hold what an earlier configuration put there. */
export interface PlannedStep extends InstallStep {
  role?: ModelRole;
  spec?: ModelSpec;
  refused?: string;
}

/** Whether a step's block takes a `path` — the one condition under which a file the reader already has can stand in. */
const takesFile = (id: string): boolean => `model.${id}.path` in modelSettings;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The steps this run performs, in order, from the model family alone: the machine, the reasoning model, then
 * every service whose block is present, each with its spec. A block that selects nothing it can — a
 * `reranker: {}`, a vision block under a `path:` llm — is refused before anything runs; mid-walk, where a
 * persisted change re-derives the steps, `lenient` returns that step as failed with the refusal as its note
 * instead. A step's label is framework words: the model, and each service's model by the service's name.
 */
export function planInstall(model: ModelFamily, opts: { lenient?: boolean } = {}): PlannedStep[] {
  const llm = model.llm ?? {};
  const steps: PlannedStep[] = [
    { id: 'machine', label: 'This machine', status: 'pending' },
    { id: 'llm', label: 'Getting the model', status: 'pending', role: 'llm', file: takesFile('llm'), ...(llm.path || llm.id ? { spec: llm.path ? { path: llm.path } : { id: llm.id } } : {}) },
  ];
  for (const name of configuredServices(model)) {
    const step: PlannedStep = { id: name, label: `Getting the ${name} model`, status: 'pending', role: name, file: takesFile(name) };
    try {
      step.spec = specOf(name, model);
    } catch (err) {
      if (!opts.lenient) throw err;
      step.status = 'failed';
      step.refused = message(err);
      step.note = step.refused;
    }
    steps.push(step);
  }
  return steps;
}

/** Whether a step moves bytes: a catalog id not yet in its slot. A `path`, or a slot to adopt from, is already here. */
const fetches = (projectRoot: string, step: PlannedStep): boolean =>
  step.role !== undefined && step.spec?.id !== undefined && !isModelPresent(projectRoot, step.role, step.spec.id);

const sameSpec = (a: ModelSpec | undefined, b: ModelSpec | undefined): boolean => a?.id === b?.id && a?.path === b?.path;

/**
 * The steps as the fresh derivation has them, with what the walk already did carried over wherever the
 * derivation agrees: a step whose spec is unchanged keeps its status and its artifact; one whose spec changed,
 * or that the fresh derivation refuses, starts again with its artifact dropped. The machine step is never
 * re-derived. Mutates `steps` in place so the reported list stays the one list.
 */
function reconcile(steps: PlannedStep[], fresh: PlannedStep[], artifacts: Record<string, string>): void {
  const before = new Map(steps.map((s) => [s.id, s]));
  steps.length = 0;
  for (const next of fresh) {
    const prev = before.get(next.id);
    if (next.id === 'machine' && prev) { steps.push(prev); continue; }
    if (prev && !next.refused && !prev.refused && sameSpec(prev.spec, next.spec)) { steps.push(prev); continue; }
    delete artifacts[next.id];
    steps.push(next);
  }
}

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
  // A view hears from the install once there is something it must act on or wait through: a step that
  // fetches, or a step that failed — whichever comes first. Silent otherwise, so a run that acquires nothing
  // and fails at nothing simply opens.
  let announced = false;
  const send = (): void => opts.report({ type: 'install:step', steps: steps.map(({ role: _r, spec: _s, refused: _f, ...step }) => ({ ...step })) });
  const publish = (): void => { announced = true; send(); };
  const set = (step: PlannedStep, patch: Partial<InstallStep>): void => {
    Object.assign(step, patch);
    if (patch.status === 'failed' && !announced) publish();
    else if (announced) send();
  };

  // The machine, before a byte is fetched — and on every start, since weights carried onto a box too small for
  // them fail as hard as ones downloaded onto it. A model with no class is trusted by possession.
  const [machine, llmStep] = steps;
  const entry: ModelCatalogEntry | undefined = llmStep.spec?.id ? catalogEntry('llm', llmStep.spec.id) : undefined;
  const verdict = entry ? checkMachine(entry, opts.totalBytes) : null;
  if (verdict) machine.note = `${gb(verdict.totalBytes)} · ${gb(verdict.neededBytes)} needed`;
  if (verdict && !verdict.ok) {
    set(machine, { status: 'failed' });
    throw new Error(refusalMessage(verdict, entry!.label));
  }
  machine.status = 'done';
  if (steps.some((step) => fetches(opts.projectRoot, step))) publish();

  // A slot from before the role was named for its service is carried over once, before the walk — a migration
  // with a sunset: every project scaffolded since cut 10 has the new slot, so this goes with the cut after next.
  carryOverVisionSlot(opts.projectRoot, say);

  const artifacts: Record<string, string> = {};
  // The walk resumes from the earliest step not yet done, so a step a persisted change sent back to pending —
  // a model replaced by a file, the projector that derived from it — is run again in its place.
  const next = (): number => steps.findIndex((s) => s.id !== 'machine' && s.status !== 'done');
  for (let i = next(); i !== -1; i = next()) {
    const step = steps[i];
    let attempt: Attempt;
    if (step.refused) {
      // Nothing to resolve: a slot may still hold what an earlier configuration put there, and adopting it
      // would be exactly the wrong model. The refusal stands until a file gives the step a spec.
      attempt = { error: new Error(step.refused) };
    } else {
      set(step, { status: 'running', got: undefined, total: undefined, note: undefined });
      attempt = yield* attemptStep(step, opts, (got, total) => set(step, { got, total }));
    }
    if ('artifact' in attempt) {
      artifacts[step.id] = attempt.artifact;
      set(step, { status: 'done', got: undefined, total: undefined, ...(step.spec?.id ? { note: catalogEntry(step.role!, step.spec.id)?.label ?? step.spec.id } : {}) });
      continue;
    }
    let command: InstallCommand;
    if ('command' in attempt) {
      command = attempt.command;
    } else {
      set(step, { status: 'failed', note: message(attempt.error) });
      if (!opts.controls) throw attempt.error;
      command = yield* nextCommand(opts.controls);
    }
    if (command.type === 'install:quit') throw new Error('the install was stopped');
    if (command.type === 'install:use_file') {
      if (!opts.persist) throw new Error('install: a file was chosen, but nothing here can remember it — `persist` is required beside `controls`');
      // Remembered first, then the steps derived again from what was remembered: the file's own step, and
      // every step whose selection followed from the one that changed.
      model = opts.persist({ model: { [command.step]: { path: command.path } } });
      reconcile(steps, planInstall(model, { lenient: true }), artifacts);
      if (steps.some((s) => s.status === 'failed')) publish();
      else if (announced) send();
    }
    // A retry runs this step again from its spec as it now stands; a file runs the walk again from the earliest
    // step it touched.
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
