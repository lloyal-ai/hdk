/**
 * The interactive `create` picker — an Ink wizard that collects
 * name → targets → model → template, then hands the answers back for the pure
 * scaffold logic to act on. Mounted ONLY when `create` runs in a TTY with
 * arguments missing; flags + non-TTY take the plain path in `create.ts`.
 *
 * Built on Ink + `@inkjs/ui` (pure-JS, MIT) — the same stack the scaffolded
 * harnesses render in, so the tool eats its own dog food. It stays thin: no
 * scaffolding happens here, only data collection.
 */
import { useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { TextInput, Select, MultiSelect, StatusMessage } from '@inkjs/ui';
import { modelsForRole } from '../scaffold/model-catalog.js';
import type { Target } from '../scaffold/prune-targets.js';

export type TemplateKind = 'blank' | 'research';

export interface WizardResult {
  name: string;
  targets: Target[];
  llmId: string;
  template: TemplateKind;
}

/** Same grammar as the non-interactive path (`create.ts` NAME_RE). */
const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const TARGET_ORDER: Target[] = ['cli', 'desktop', 'web'];

export function orderTargets(values: string[]): Target[] {
  const set = new Set(values);
  set.add('cli'); // cli carries the engine bin — always kept
  return TARGET_ORDER.filter((t) => set.has(t));
}

export function Wizard({ onDone }: { onDone: (result: WizardResult | null) => void }): React.ReactElement {
  const { exit } = useApp();
  const llms = modelsForRole('llm');
  const defaultLlm = llms[0]?.id ?? 'reasoning-4b';

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [targets, setTargets] = useState<Target[]>(['cli', 'desktop', 'web']);
  const [llmId, setLlmId] = useState(defaultLlm);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onDone(null);
      exit();
    }
  });

  const submitName = (value: string): void => {
    const trimmed = value.trim();
    if (!NAME_RE.test(trimmed)) {
      setNameError(`"${trimmed}" — expected [a-z][a-z0-9_-]{1,63} (lowercase, starts with a letter).`);
      return;
    }
    setName(trimmed);
    setNameError(null);
    setStep(1);
  };

  const submitTargets = (values: string[]): void => {
    setTargets(orderTargets(values));
    setStep(2);
  };

  const submitModel = (value: string): void => {
    setLlmId(value);
    setStep(3);
  };

  const submitTemplate = (value: string): void => {
    onDone({ name, targets, llmId, template: value as TemplateKind });
    exit();
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Scaffold a new harness</Text>

      {step > 0 && <Text dimColor>{`  name      ${name}`}</Text>}
      {step > 1 && <Text dimColor>{`  targets   ${targets.join(', ')}`}</Text>}
      {step > 2 && <Text dimColor>{`  model     ${llmId}`}</Text>}

      {step === 0 && (
        <Box flexDirection="column">
          <Text>Harness name:</Text>
          <TextInput placeholder="my-harness" onSubmit={submitName} />
          {nameError && <StatusMessage variant="error">{nameError}</StatusMessage>}
        </Box>
      )}

      {step === 1 && (
        <Box flexDirection="column">
          <Text>Targets (space to toggle, enter to confirm — cli is always included):</Text>
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

      {step === 2 && (
        <Box flexDirection="column">
          <Text>Model:</Text>
          <Select
            options={llms.map((m) => ({ label: m.label, value: m.id }))}
            defaultValue={defaultLlm}
            onChange={submitModel}
          />
        </Box>
      )}

      {step === 3 && (
        <Box flexDirection="column">
          <Text>Template:</Text>
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
 * user cancels (Ctrl-C / the Ink app exits before completing).
 */
export function runCreateWizard(): Promise<WizardResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: WizardResult | null): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const { waitUntilExit } = render(<Wizard onDone={done} />);
    void waitUntilExit().then(() => done(null));
  });
}
