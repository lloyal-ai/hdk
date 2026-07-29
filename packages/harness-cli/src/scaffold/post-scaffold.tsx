/**
 * After a scaffold completes: optionally run `npm install` behind a spinner,
 * then print a per-target "how to run it" panel. Without this the flow
 * dead-ends — the user lands in a shell with no `node_modules` and only a guess
 * at the script name (`npm run dev:web` → `vite: command not found`).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Box, Text, render, useApp } from 'ink';
import { Spinner, ThemeProvider } from '@inkjs/ui';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliTheme, ACCENT_SGR } from './palette.js';
import type { Target } from './prune-targets.js';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function InstallScreen({ dir, onDone }: { dir: string; onDone: (ok: boolean) => void }): ReactElement {
  const { exit } = useApp();
  const [phase, setPhase] = useState<'installing' | 'ok' | 'fail'>('installing');

  useEffect(() => {
    const child = spawn(NPM, ['install'], { cwd: dir, stdio: 'ignore' });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      setPhase(ok ? 'ok' : 'fail');
      onDone(ok);
    };
    child.on('close', (code) => finish(code === 0));
    child.on('error', () => finish(false));
    return () => {
      if (!settled) child.kill();
    };
  }, [dir, onDone]);

  // Once resolved, let the final (✓ / !) frame paint, then unmount — so the
  // terminal is left showing the result, not a frozen spinner glyph.
  useEffect(() => {
    if (phase === 'installing') return undefined;
    const id = setTimeout(() => exit(), 24);
    return () => clearTimeout(id);
  }, [phase, exit]);

  if (phase === 'installing') {
    return (
      <Box gap={1}>
        <Spinner />
        <Text>
          Installing dependencies <Text dimColor>— vite · ink · electron, ~a minute</Text>
        </Text>
      </Box>
    );
  }
  if (phase === 'ok') {
    return (
      <Text>
        <Text color="green">✓</Text> Dependencies installed
      </Text>
    );
  }
  return (
    <Text>
      <Text color="yellow">!</Text> Couldn&apos;t install automatically — run{' '}
      <Text bold>npm install</Text> in the project.
    </Text>
  );
}

/** Run `npm install` in `dir` behind a spinner. Resolves true on success. */
export function runInstall(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const { waitUntilExit } = render(
      <ThemeProvider theme={cliTheme}>
        <InstallScreen dir={dir} onDone={(v) => (ok = v)} />
      </ThemeProvider>,
    );
    void waitUntilExit().then(() => resolve(ok));
  });
}

/** Per-target run command + a one-word label for the surface. */
const RUN: Record<Target, { cmd: string; label: string; note?: string }> = {
  cli: { cmd: 'npm start', label: 'Terminal' },
  desktop: { cmd: 'npm run dev:desktop', label: 'Desktop window' },
  web: { cmd: 'npm run dev:web', label: 'Browser', note: 'boots the host + browser' },
};

/** Markdown "how to run each surface" block for the scaffolded README. */
export function runStepsMarkdown(targets: Target[]): string {
  return targets
    .map((t) => {
      const { cmd, label, note } = RUN[t];
      return `- **${label}** — \`${cmd}\`${note ? ` — ${note}` : ''}`;
    })
    .join('\n');
}

/** Replace the README's `__RUN_STEPS__` marker with the kept targets' commands. */
export function writeReadmeRunSteps(dir: string, targets: Target[]): void {
  const readme = join(dir, 'README.md');
  try {
    const src = readFileSync(readme, 'utf8');
    if (src.includes('__RUN_STEPS__')) {
      writeFileSync(readme, src.replace('__RUN_STEPS__', runStepsMarkdown(targets)));
    }
  } catch {
    // A template without a README (or an unreadable one) is not fatal to the scaffold.
  }
}

/** Print the "you're set — here's how to run it" panel (ANSI-colored on a TTY). */
export function printNextSteps(opts: { name: string; targets: Target[]; installed: boolean }): void {
  const tty = Boolean(process.stdout.isTTY);
  const c = (code: string, s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const amber = (s: string): string => c(ACCENT_SGR, s); // matches ACCENT everywhere else
  const dim = (s: string): string => c('2', s);
  const bold = (s: string): string => c('1', s);

  const lines: string[] = ['', `${bold(opts.name)} is ready.`, ''];
  lines.push(`  ${dim(`cd ${opts.name}`)}`);
  if (!opts.installed) lines.push(`  ${dim('npm install')}`);
  lines.push('', `  ${c(`${ACCENT_SGR};1`, 'Run it')}`);
  for (const t of opts.targets) {
    const step = RUN[t];
    const note = step.note ? `  ${dim(`(${step.note})`)}` : '';
    lines.push(`    ${amber(t.padEnd(9))}${step.cmd}${note}`);
  }
  lines.push('');
  lines.push(`  ${dim('First run fetches + digest-verifies the model — no API key.')}`);
  lines.push(`  ${dim('Add apps:  npx harness.dev install <publisher>/<name>')}`);
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}
