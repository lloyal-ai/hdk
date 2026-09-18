/**
 * `useDevOverlay`: the terminal view's whole share of the dev tools. The view hands it the bus and gets back the
 * overlay and a toggle; the hook owns the fold, the wire's dev gate and the event tail, so a view assembles
 * none of them.
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createElement } from 'react';
import { Box, render, Text } from 'ink';
import { useDevOverlay } from '../src/ink';

function capture(): { stream: NodeJS.WriteStream; text: () => string } {
  let out = '';
  const stream = new Writable({ write(chunk, _e, done) { out += String(chunk); done(); } });
  return { stream: Object.assign(stream, { columns: 100, rows: 30 }) as unknown as NodeJS.WriteStream, text: () => out };
}
const painted = (): Promise<void> => new Promise((r) => setTimeout(r, 80));
/** Wait for a frame that matches, not for a fixed time: a loaded machine paints late. */
async function shown(text: () => string, what: RegExp): Promise<void> {
  for (let i = 0; i < 100 && !what.test(text()); i++) await new Promise((r) => setTimeout(r, 20));
}

function bus() {
  const subs = new Set<(ev: { type: string }) => void>();
  return { subscribe: (cb: (ev: { type: string }) => void) => { subs.add(cb); return () => subs.delete(cb); }, send: (ev: { type: string } & Record<string, unknown>) => subs.forEach((cb) => cb(ev)) };
}

describe('useDevOverlay', () => {
  it('shows nothing until the wire says dev, then the overlay with the events it has heard', async () => {
    const b = bus();
    let toggle: () => void = () => {};
    function View() {
      const dev = useDevOverlay(b);
      toggle = dev.toggle;
      return createElement(Box, { flexDirection: 'column' }, createElement(Text, null, 'app'), dev.overlay);
    }
    const out = capture();
    const app = render(createElement(View), { stdout: out.stream, patchConsole: false, exitOnCtrlC: false, debug: true });
    toggle();
    b.send({ type: 'query' });
    await painted();
    expect(out.text()).not.toMatch(/ctrl\+g close/);          // open, but the wire never said dev

    b.send({ type: 'config:loaded', dev: true, config: {}, origin: {} });
    b.send({ type: 'plan:start' });
    b.send({ type: 'agent:produce', agentId: 1, text: 'x', tokenCount: 1 });   // token traffic is not a tail line
    await shown(out.text, /plan:start/);
    expect(out.text()).toMatch(/ctrl\+g close/);
    expect(out.text()).toMatch(/plan:start/);
    expect(out.text()).not.toMatch(/agent:produce/);
    app.unmount();
  });

  it('a closed overlay costs the view no render however many events the wire says; an open one repaints', async () => {
    const b = bus();
    let toggle: () => void = () => {};
    let renders = 0;
    function View() {
      renders += 1;
      const dev = useDevOverlay(b);
      toggle = dev.toggle;
      return createElement(Box, { flexDirection: 'column' }, createElement(Text, null, 'app'), dev.overlay);
    }
    const out = capture();
    const app = render(createElement(View), { stdout: out.stream, patchConsole: false, exitOnCtrlC: false, debug: true });
    b.send({ type: 'config:loaded', dev: true, config: {}, origin: {} });
    await painted();
    const before = renders;
    for (let i = 0; i < 50; i++) b.send({ type: 'agent:produce', agentId: 1, text: 'x', tokenCount: i });
    b.send({ type: 'agent:tick', agentId: 1, cellsUsed: 250, nCtx: 1000 });
    await painted();
    expect(renders).toBe(before);
    toggle();
    await shown(out.text, /25%/);   // what was folded while closed is shown the moment it opens
    b.send({ type: 'agent:tick', agentId: 1, cellsUsed: 500, nCtx: 1000 });
    await shown(out.text, /50%/);
    expect(out.text()).toMatch(/50%/);
    app.unmount();
  });

  it('tick traffic is never a tail line, but the pressure it carries repaints the open overlay', async () => {
    const b = bus();
    let toggle: () => void = () => {};
    function View() {
      const dev = useDevOverlay(b);
      toggle = dev.toggle;
      return createElement(Box, { flexDirection: 'column' }, createElement(Text, null, 'app'), dev.overlay);
    }
    const out = capture();
    const app = render(createElement(View), { stdout: out.stream, patchConsole: false, exitOnCtrlC: false, debug: true });
    b.send({ type: 'config:loaded', dev: true, config: {}, origin: {} });
    toggle();
    await shown(out.text, /ctrl\+g close/);
    b.send({ type: 'agent:tick', agentId: 1, cellsUsed: 250, nCtx: 1000 });
    await shown(out.text, /25%/);
    expect(out.text()).toMatch(/25%/);
    expect(out.text()).not.toMatch(/agent:tick/);
    app.unmount();
  });
});
