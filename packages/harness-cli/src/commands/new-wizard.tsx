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
import { createRequire } from 'node:module';
import { useRef, useState, type ReactElement } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { TextInput, Select, MultiSelect, ThemeProvider } from '@inkjs/ui';
import { modelsForRole } from '../scaffold/model-catalog.js';
import { cliTheme, ACCENT } from '../scaffold/palette.js';
import type { Target } from '../scaffold/prune-targets.js';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

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

// Brand gradient — a horizontal sweep across the mark and wordmark. Truecolor
// stops; terminals without 24-bit color downsample gracefully.
type RGB = readonly [number, number, number];
const STOPS: readonly RGB[] = [
  [45, 212, 191], // #2DD4BF teal
  [99, 102, 241], // #6366F1 indigo
  [217, 70, 239], // #D946EF fuchsia
];

/** Sample the multi-stop gradient at t ∈ [0,1]. */
function sample(t: number): RGB {
  const span = STOPS.length - 1;
  const seg = Math.min(Math.max(t, 0), 1) * span;
  const i = Math.min(Math.floor(seg), span - 1);
  const f = seg - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const hex = (c: RGB): string =>
  `#${c.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
const dim = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** A word painted with the brand gradient, one hue step per character. */
function GradientWord({ text, bold }: { text: string; bold?: boolean }): ReactElement {
  const chars = [...text];
  const last = Math.max(chars.length - 1, 1);
  return (
    <Text bold={bold}>
      {chars.map((ch, i) => (
        <Text key={i} color={hex(sample(i / last))}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

// The lloyal [LL] mark as block art (matches src/assets/logo-white.png):
// an open bracket, two Ls, a close bracket.
const MARK_ROWS: readonly string[] = [
  '███ █   █   ███',
  '█   █   █     █',
  '█   █   █     █',
  '█   █   █     █',
  '█   █   █     █',
  '█   █   █     █',
  '███ ███ ███ ███',
];
const MARK_W = Math.max(...MARK_ROWS.map((r) => r.length));

// Horizontal extent of solids per row — used to keep the shadow on the mark's
// outer silhouette (baseline + right edge) rather than filling the interior
// negative space (bracket mouths, letter gaps), which reads as noise.
const MARK_BOUNDS = MARK_ROWS.map((row) => {
  let min = Infinity;
  let max = -Infinity;
  for (let c = 0; c < row.length; c++)
    if (row[c] === '█') {
      min = Math.min(min, c);
      max = Math.max(max, c);
    }
  return { min, max };
});

type Cell = 'solid' | 'shadow' | 'empty';
const markSolid = (r: number, c: number): boolean =>
  r >= 0 && r < MARK_ROWS.length && c >= 0 && c < MARK_ROWS[r].length && MARK_ROWS[r][c] === '█';

/** True when (r,c) is interior negative space (enclosed left and right by solids). */
const enclosed = (r: number, c: number): boolean => {
  const b: { min: number; max: number } | undefined = MARK_BOUNDS[r];
  return b !== undefined && c > b.min && c < b.max;
};

/** Solid glyph, or a drop-shadow offset down-right on the outer silhouette — the "trail". */
function markCell(r: number, c: number): Cell {
  if (markSolid(r, c)) return 'solid';
  if (markSolid(r - 1, c - 1) && !enclosed(r, c)) return 'shadow';
  return 'empty';
}

/** The big [LL] emblem: block glyphs, a horizontal gradient, a stippled shadow. */
function BigMark(): ReactElement {
  const rows: ReactElement[] = [];
  for (let r = 0; r <= MARK_ROWS.length; r++) {
    const cells: ReactElement[] = [];
    for (let c = 0; c <= MARK_W; c++) {
      const kind = markCell(r, c);
      const tint = sample(c / MARK_W);
      if (kind === 'solid') {
        cells.push(
          <Text key={c} color={hex(tint)}>
            █
          </Text>,
        );
      } else if (kind === 'shadow') {
        cells.push(
          <Text key={c} color={hex(dim(tint, 0.5))}>
            ░
          </Text>,
        );
      } else {
        cells.push(<Text key={c}> </Text>);
      }
    }
    rows.push(<Text key={r}>{cells}</Text>);
  }
  return <Box flexDirection="column">{rows}</Box>;
}

/**
 * The boot banner: the big [LL] mark (block art + gradient + dithered shadow)
 * over the wordmark, a one-line pitch, and the version. The tool's front door —
 * brand-forward like a real CLI splash, sized to a mark, not a figlet wall.
 */
function Banner(): ReactElement {
  return (
    <Box flexDirection="column">
      <BigMark />
      <Box width="100%" justifyContent="space-between" marginTop={1}>
        <Box gap={2}>
          <GradientWord text="harness.dev" bold />
          <Text dimColor>rails new for agentic AI apps</Text>
        </Box>
        <Text dimColor>v{VERSION}</Text>
      </Box>
      <Text dimColor>the model lives inside your app — no API key</Text>
    </Box>
  );
}

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

/** A one-line question header: a bold amber label + a dim inline hint. */
function Field({ label, hint }: { label: string; hint: string }): ReactElement {
  return (
    <Text>
      <Text color={ACCENT} bold>
        {label}
      </Text>
      <Text dimColor>{`   ${hint}`}</Text>
    </Text>
  );
}

/** A text-entry row: a `❯` prompt marker + the input on one line. */
function Prompt({
  placeholder,
  onChange,
  onSubmit,
}: {
  placeholder: string;
  onChange: () => void;
  onSubmit: (value: string) => void;
}): ReactElement {
  return (
    <Box>
      <Text color={ACCENT}>❯ </Text>
      <TextInput placeholder={placeholder} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
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
  const defaultLlm = llms[0]?.id ?? 'qwen3.5-4b';
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
    if (!trimmed) {
      setNameError('Type a name, then press enter.');
      return;
    }
    if (!NAME_RE.test(trimmed)) {
      setNameError('Use lowercase letters, digits, - and _ — starting with a letter.');
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
      setByoError('Enter a path to a local .gguf, or press ctrl-c to cancel.');
      return;
    }
    setLlm(trimmed);
    setByoError(null);
    advance(queue.slice(1), { llm: trimmed });
  };

  const submitTemplate = (value: string): void => {
    advance(queue.slice(1), { template: value as TemplateKind });
  };

  const hasAnswers = Boolean(
    collected.current.name || collected.current.targets || collected.current.llm,
  );

  return (
    <Box flexDirection="column">
      <Banner />

      <Box marginTop={1}>
        <Text dimColor>Scaffold a new harness</Text>
      </Box>

      {hasAnswers && (
        <Box flexDirection="column" marginTop={1}>
          {collected.current.name && <Text dimColor>{`  name      ${collected.current.name}`}</Text>}
          {collected.current.targets && (
            <Text dimColor>{`  targets   ${collected.current.targets.join(', ')}`}</Text>
          )}
          {collected.current.llm && <Text dimColor>{`  model     ${collected.current.llm}`}</Text>}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {step === 'name' && (
          <Box flexDirection="column">
            <Field label="Harness name" hint="lowercase — becomes the folder + npm name" />
            <Prompt
              placeholder="my-harness"
              onChange={() => {
                if (nameError) setNameError(null);
              }}
              onSubmit={submitName}
            />
            {nameError && <Text color="red">{`  ${nameError}`}</Text>}
          </Box>
        )}

        {step === 'targets' && (
          <Box flexDirection="column">
            <Field label="Targets" hint="cli terminal · desktop window · web browser — one reduce" />
            <Text dimColor>space toggles, enter confirms — cli is always included.</Text>
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
            <Field label="Trunk model" hint="fetched + digest-verified on first run — no key" />
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
            <Field label="Path to your .gguf" hint="absolute or project-relative — trusted as-is" />
            <Prompt
              placeholder="./models/llm/my-model.gguf"
              onChange={() => {
                if (byoError) setByoError(null);
              }}
              onSubmit={submitByo}
            />
            {byoError && <Text color="red">{`  ${byoError}`}</Text>}
          </Box>
        )}

        {step === 'template' && (
          <Box flexDirection="column">
            <Field label="Template" hint="the starting point — you own the code either way" />
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
    const { waitUntilExit } = render(
      <ThemeProvider theme={cliTheme}>
        <Wizard onDone={done} prefill={prefill} />
      </ThemeProvider>,
    );
    void waitUntilExit().then(() => done(null));
  });
}
