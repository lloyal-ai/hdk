/**
 * The interactive `new` picker — an Ink wizard that collects
 * name → targets → model → template, then hands the answers back for the pure
 * scaffold logic to act on. Mounted ONLY when `new` runs in a TTY with the
 * name missing; a provided name / `--yes` / non-TTY take the plain path in
 * `new.ts`.
 *
 * Any flags the user DID pass (`--template`/`--targets`/`--model`) pre-seed the
 * wizard, so it prompts only for what's missing (flag-compose). Each question
 * carries a one-line teaching note — the picker doubles as a tour of the
 * conventions.
 *
 * Built on Ink + `@inkjs/ui` (pure-JS, MIT) — the same stack the scaffolded
 * harnesses render in, so the tool eats its own dog food. It stays thin: no
 * scaffolding happens here, only data collection.
 */
import { useRef, useState, type ReactElement } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { TextInput, Select, MultiSelect, StatusMessage } from '@inkjs/ui';
import { modelsForRole } from '../scaffold/model-catalog.js';
import type { Target } from '../scaffold/prune-targets.js';

export type TemplateKind = 'blank' | 'research';

export interface WizardResult {
  name: string;
  targets: Target[];
  /** Catalog id OR a BYO `.gguf` path (see `applyModelChoice`). */
  llm: string;
  template: TemplateKind;
}

/** Flags already provided on the command line — the wizard skips these steps. */
export interface WizardPrefill {
  template?: TemplateKind;
  targets?: Target[];
  llm?: string;
}

/** Same grammar as the non-interactive path (`new.ts` NAME_RE). */
const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const TARGET_ORDER: Target[] = ['cli', 'desktop', 'web'];
const DEFAULT_TARGETS: Target[] = ['cli', 'desktop', 'web'];

export function orderTargets(values: string[]): Target[] {
  const set = new Set(values);
  set.add('cli'); // cli carries the engine bin — always kept
  return TARGET_ORDER.filter((t) => set.has(t));
}

/** The screens the wizard walks, minus any the flags already answered. */
type StepId = 'name' | 'targets' | 'model' | 'byo' | 'template';

function initialQueue(prefill: WizardPrefill): StepId[] {
  const q: StepId[] = ['name']; // the wizard only mounts when the name is missing
  if (!prefill.targets) q.push('targets');
  if (!prefill.llm) q.push('model');
  if (!prefill.template) q.push('template');
  return q;
}

export function Wizard({
  onDone,
  prefill = {},
}: {
  onDone: (result: WizardResult | null) => void;
  prefill?: WizardPrefill;
}): ReactElement {
  const { exit } = useApp();
  const llms = modelsForRole('llm');
  const defaultLlm = llms[0]?.id ?? 'reasoning-4b';
  const defaultLlmLabel = llms[0]?.label ?? defaultLlm;

  const [queue, setQueue] = useState<StepId[]>(() => initialQueue(prefill));
  const step = queue[0];

  // The running answers. A ref so finalize() never reads stale state after the
  // last step's setState hasn't flushed; useState mirrors it for the summary.
  const collected = useRef<Partial<WizardResult>>({});
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [byoError, setByoError] = useState<string | null>(null);
  const [targets, setTargets] = useState<Target[]>(prefill.targets ?? DEFAULT_TARGETS);
  const [llm, setLlm] = useState(prefill.llm ?? defaultLlm);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onDone(null);
      exit();
    }
  });

  /** Commit a patch, then move to `nextQueue` — or finalize when it's empty. */
  const advance = (nextQueue: StepId[], patch: Partial<WizardResult>): void => {
    collected.current = { ...collected.current, ...patch };
    if (nextQueue.length === 0) {
      onDone({
        name: collected.current.name ?? '',
        targets: collected.current.targets ?? prefill.targets ?? DEFAULT_TARGETS,
        llm: collected.current.llm ?? prefill.llm ?? defaultLlm,
        template: collected.current.template ?? prefill.template ?? 'blank',
      });
      exit();
      return;
    }
    setQueue(nextQueue);
  };

  const submitName = (value: string): void => {
    const trimmed = value.trim();
    if (!NAME_RE.test(trimmed)) {
      setNameError(`"${trimmed}" — expected [a-z][a-z0-9_-]{1,63} (lowercase, starts with a letter).`);
      return;
    }
    setName(trimmed);
    setNameError(null);
    advance(queue.slice(1), { name: trimmed });
  };

  const submitTargets = (values: string[]): void => {
    const ordered = orderTargets(values);
    setTargets(ordered);
    advance(queue.slice(1), { targets: ordered });
  };

  const submitModel = (value: string): void => {
    if (value === 'byo') {
      // Detour to the path prompt before continuing with the remaining steps.
      setQueue(['byo', ...queue.slice(1)]);
      return;
    }
    // 'recommended' and 'later' both write the catalog default; the difference
    // is framing (the summary note nudges "later" toward editing harness.yml).
    setLlm(defaultLlm);
    advance(queue.slice(1), { llm: defaultLlm });
  };

  const submitByo = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      setByoError('Enter a path to a local .gguf, or press Ctrl-C to cancel.');
      return;
    }
    setLlm(trimmed);
    setByoError(null);
    advance(queue.slice(1), { llm: trimmed });
  };

  const submitTemplate = (value: string): void => {
    advance(queue.slice(1), { template: value as TemplateKind });
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Scaffold a new harness</Text>

      {collected.current.name && <Text dimColor>{`  name      ${collected.current.name}`}</Text>}
      {collected.current.targets && (
        <Text dimColor>{`  targets   ${collected.current.targets.join(', ')}`}</Text>
      )}
      {collected.current.llm && <Text dimColor>{`  model     ${collected.current.llm}`}</Text>}

      {step === 'name' && (
        <Box flexDirection="column">
          <Text>Harness name:</Text>
          <Text dimColor>lowercase letters, digits, - and _ — becomes the folder and npm name.</Text>
          <TextInput placeholder="my-harness" onSubmit={submitName} />
          {nameError && <StatusMessage variant="error">{nameError}</StatusMessage>}
        </Box>
      )}

      {step === 'targets' && (
        <Box flexDirection="column">
          <Text>Targets (space to toggle, enter to confirm — cli is always included):</Text>
          <Text dimColor>
            cli = terminal · desktop = native window · web = browser app + host, one reduce.
          </Text>
          <MultiSelect
            options={[
              { label: 'cli (required)', value: 'cli' },
              { label: 'desktop', value: 'desktop' },
              { label: 'web', value: 'web' },
            ]}
            defaultValue={targets}
            onSubmit={submitTargets}
          />
        </Box>
      )}

      {step === 'model' && (
        <Box flexDirection="column">
          <Text>Trunk model:</Text>
          <Text dimColor>catalog models are fetched + digest-verified on first run — no API key.</Text>
          <Select
            options={[
              { label: `Recommended — ${defaultLlmLabel}`, value: 'recommended' },
              { label: 'Bring your own — a local .gguf you already have', value: 'byo' },
              { label: 'Decide later — keep the default, edit harness.yml', value: 'later' },
            ]}
            onChange={submitModel}
          />
        </Box>
      )}

      {step === 'byo' && (
        <Box flexDirection="column">
          <Text>Path to your .gguf:</Text>
          <Text dimColor>absolute, or relative to the project — trusted as-is, not digest-verified.</Text>
          <TextInput placeholder="./models/llm/my-model.gguf" onSubmit={submitByo} />
          {byoError && <StatusMessage variant="error">{byoError}</StatusMessage>}
        </Box>
      )}

      {step === 'template' && (
        <Box flexDirection="column">
          <Text>Template:</Text>
          <Text dimColor>the starting point — you own the code either way.</Text>
          <Select
            options={[
              { label: 'blank — minimal 2-agent pipeline', value: 'blank' },
              { label: 'research — tuned recon → plan → agents → synth', value: 'research' },
            ]}
            onChange={submitTemplate}
          />
        </Box>
      )}
    </Box>
  );
}

/**
 * Mount the wizard and resolve with the collected answers, or `null` if the
 * user cancels (Ctrl-C / the Ink app exits before completing). Any `prefill`
 * (flags already provided) narrows the questions asked.
 */
export function runNewWizard(prefill: WizardPrefill = {}): Promise<WizardResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: WizardResult | null): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const { waitUntilExit } = render(<Wizard onDone={done} prefill={prefill} />);
    void waitUntilExit().then(() => done(null));
  });
}
