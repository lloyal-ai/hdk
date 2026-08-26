/**
 * `<DevOverlay>` — the terminal dev overlay (ctrl+g in the cli view).
 *
 * BOUNDED height by contract: the cli view keeps finished work in Ink's
 * `<Static>` and its dynamic frame under the terminal height — an overlay
 * that grows past the frame makes Ink clear-and-repaint, wiping scrollback.
 * This component renders a fixed number of rows (a pressure sparkline, one
 * provenance line, a short event tail) and never more.
 *
 * The view owns the toggle: fold events into a `PaneModel` (`foldEvent`) and
 * render `<DevOverlay model={m} />` when visible. Render nothing when the
 * model says `dev: false` — the gate is the wire's, not the view's.
 *
 * @category DevTools
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { pressurePercent, sparkline } from './index.js';
import type { PaneModel } from './index.js';

export { sparkline } from './index.js';

export interface DevOverlayProps {
  model: PaneModel;
  /** Rows of event tail to show (bounded — default 5). */
  tailRows?: number;
  /** The most recent human-readable event lines, newest last — the VIEW
   *  formats these (it owns the template's event vocabulary); the overlay
   *  just bounds and prints them. */
  tail?: readonly string[];
}

/** The overlay is bounded BY CONTRACT (Ink wipes scrollback past the frame) —
 *  clamp the tail rows so no caller value can grow it. */
const MAX_TAIL_ROWS = 12;

export function DevOverlay({ model: m, tailRows = 5, tail = [] }: DevOverlayProps): ReactElement | null {
  if (!m.dev) return null;
  const rows = Math.max(0, Math.min(MAX_TAIL_ROWS, Math.floor(tailRows)));
  const pct = pressurePercent(m);
  const origin = m.origin ?? {};
  const originLine = Object.entries(origin)
    .map(([k, v]) => `${k}:${v}`)
    .join('  ');
  const bounded = rows === 0 ? [] : tail.slice(-rows);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box gap={2}>
        <Text color="blueBright" bold>dev</Text>
        <Text dimColor>{m.eventCount} events</Text>
        {pct !== null && (
          <Text>
            <Text color="blueBright">{sparkline(m, 24)}</Text>
            <Text> {pct}%</Text>
            <Text dimColor> · attention cells</Text>
          </Text>
        )}
        <Text dimColor>ctrl+g close</Text>
      </Box>
      {originLine !== '' && (
        <Text dimColor wrap="truncate">{originLine}</Text>
      )}
      {bounded.map((line, i) => (
        <Text key={i} wrap="truncate" dimColor>{line}</Text>
      ))}
    </Box>
  );
}
