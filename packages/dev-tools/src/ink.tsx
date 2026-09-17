/**
 * The terminal's share of the dev tools: `useDevOverlay(bus)` hands a view the overlay and its toggle, and owns
 * everything behind them — the fold, the wire's dev gate, the event tail. `<DevOverlay>` is the overlay itself,
 * for a view that folds a `PaneModel` of its own.
 *
 * BOUNDED height by contract: a terminal view keeps its dynamic frame under the terminal height, and an overlay
 * that grows past the frame makes Ink clear and repaint, wiping scrollback. The overlay renders a fixed number
 * of rows (a pressure sparkline, one provenance line, a short event tail) and never more. It renders nothing
 * unless the wire said `dev`: the gate is the wire's, not the view's.
 *
 * @category DevTools
 */
import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPaneModel, foldEvent, pressurePercent, sparkline } from './index.js';
import type { DevEvent, PaneModel, RunFraming } from './index.js';

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
  const rows = Math.max(0, Math.min(MAX_TAIL_ROWS, Number.isFinite(tailRows) ? Math.floor(tailRows) : 5));
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

/** How many events the tail remembers; the overlay shows the last few of them. */
const TAIL_KEPT = 24;
/** Token and tick traffic: folded, never listed. A tail of these would be all the tail ever showed. */
const UNLISTED = new Set(['agent:produce', 'agent:tick']);

/**
 * The dev overlay for a terminal view. Give it the bus the view already subscribes to; bind `toggle` to a key;
 * render `overlay` where it should appear.
 *
 * Until the wire's `config:loaded` says `dev`, that one event is all it folds, so a production run pays one
 * string compare per event and `overlay` stays null whatever `toggle` does.
 */
export function useDevOverlay(
  bus: { subscribe(listener: (ev: { type: string }) => void): () => void },
  opts: { framing?: RunFraming; tailRows?: number } = {},
): { overlay: ReactElement | null; open: boolean; toggle: () => void } {
  const model = useRef<PaneModel | null>(null);
  model.current ??= createPaneModel();
  const tail = useRef<string[]>([]);
  const [open, setOpen] = useState(false);
  const [, repaint] = useState(0);
  const { framing, tailRows } = opts;

  useEffect(() => bus.subscribe((ev) => {
    const m = model.current!;
    if (!m.dev && ev.type !== 'config:loaded') return;
    foldEvent(m, ev as DevEvent, Date.now(), framing);
    if (!m.dev || UNLISTED.has(ev.type)) return;
    tail.current.push(ev.type);
    if (tail.current.length > TAIL_KEPT) tail.current.shift();
    repaint((n) => n + 1);
  }), [bus, framing]);

  return {
    overlay: open ? <DevOverlay model={model.current} tail={tail.current} tailRows={tailRows} /> : null,
    open,
    toggle: () => setOpen((v) => !v),
  };
}
