/**
 * The dispatcher: one loop over the command signal, one handler per command
 * type, the handlers merged from groups the application composes. A handler
 * hands long work to the execution owner and returns; it runs under its own
 * `scoped()` boundary so what it spawns ends with it; `"exit"` from a handler
 * or from `onError` ends the loop; `quit` is the dispatcher's own.
 */
import { describe, it, expect } from 'vitest';
import { run, createSignal, spawn, sleep, ensure, suspend, withResolvers } from 'effection';
import type { Operation } from 'effection';
import { serveCommands } from '../src/serve-commands';

type Command =
  | { type: 'ask'; text: string }
  | { type: 'open'; id: string }
  | { type: 'boom' }
  | { type: 'linger' }
  | { type: 'leave' }
  | { type: 'quit' };

describe('serveCommands', () => {
  it('dispatches by type to the group that owns it; quit ends the loop with no group', async () => {
    const log: string[] = [];
    await run(function* () {
      const commands = createSignal<Command, void>();
      const asks = { handlers: { *ask(c: Extract<Command, { type: 'ask' }>) { log.push(`ask:${c.text}`); } } };
      const docs = { handlers: { *open(c: Extract<Command, { type: 'open' }>) { log.push(`open:${c.id}`); } } };
      const served = yield* spawn(() => serveCommands(commands, [asks, docs]));
      yield* sleep(0);
      commands.send({ type: 'ask', text: 'a' });
      commands.send({ type: 'open', id: 'd1' });
      commands.send({ type: 'quit' });
      yield* served;
    });
    expect(log).toEqual(['ask:a', 'open:d1']);
  });

  it('a duplicate handler across groups is refused before any command is read', async () => {
    await run(function* () {
      const commands = createSignal<Command, void>();
      const g1 = { handlers: { *ask() {} } };
      const g2 = { handlers: { *ask() {} } };
      let refused: unknown = null;
      try { yield* serveCommands(commands, [g1, g2]); } catch (e) { refused = e; }
      expect((refused as Error).message).toMatch(/ask/);
    });
  });

  it('a handler returning "exit" ends the loop', async () => {
    const log: string[] = [];
    await run(function* () {
      const commands = createSignal<Command, void>();
      const g = { handlers: { *leave() { log.push('leave'); return 'exit' as const; }, *ask() { log.push('ask'); } } };
      const served = yield* spawn(() => serveCommands(commands, [g]));
      yield* sleep(0);
      commands.send({ type: 'leave' });
      commands.send({ type: 'ask', text: 'never' });
      yield* served;
    });
    expect(log).toEqual(['leave']);
  });

  it('a throwing handler reaches onError; the loop continues unless onError says exit', async () => {
    const seen: string[] = [];
    await run(function* () {
      const commands = createSignal<Command, void>();
      let boomed = 0;
      const g = { handlers: { *boom() { boomed++; throw new Error(`boom ${boomed}`); }, *ask(c: Extract<Command, { type: 'ask' }>) { seen.push(c.text); } } };
      const served = yield* spawn(() => serveCommands(commands, [g], {
        *onError(err) {
          seen.push(`error:${(err as Error).message}`);
          if (boomed === 2) return 'exit';
        },
      }));
      yield* sleep(0);
      commands.send({ type: 'boom' });
      commands.send({ type: 'ask', text: 'still served' });
      commands.send({ type: 'boom' });
      commands.send({ type: 'ask', text: 'never' });
      yield* served;
    });
    expect(seen).toEqual(['error:boom 1', 'still served', 'error:boom 2']);
  });

  it('a handler runs under its own boundary: what it spawns ends when it returns', async () => {
    const log: string[] = [];
    await run(function* () {
      const commands = createSignal<Command, void>();
      const g = { handlers: {
        *linger() {
          yield* spawn(function* () {
            yield* ensure(() => { log.push('child:ended'); });
            yield* suspend();
          });
          yield* sleep(0); // the child starts once its parent yields (parent-first priority)
          log.push('linger:returned');
        },
        *ask() { log.push('ask'); },
      } };
      const served = yield* spawn(() => serveCommands(commands, [g]));
      yield* sleep(0);
      commands.send({ type: 'linger' });
      commands.send({ type: 'ask', text: '' });
      commands.send({ type: 'quit' });
      yield* served;
    });
    expect(log).toEqual(['linger:returned', 'child:ended', 'ask']);
  });

  it('`until` ends the loop for a fact no command carries', async () => {
    // The loop suspends on the next command, so without this there is no way out except a command —
    // and an execution owner that poisoned is exactly a fact no command carries. The session must be
    // able to end on its own, so the reader is offered a working one instead of a dead page.
    const log: string[] = [];
    await run(function* () {
      const commands = createSignal<Command, void>();
      const gate = withResolvers<void>('poisoned');
      yield* spawn(() => serveCommands(commands, [{ handlers: { *ask() { log.push('ask'); } } }], {
        until: (function* () { yield* gate.operation; log.push('until'); })(),
      }));
      yield* sleep(0);
      commands.send({ type: 'ask', text: 'a' });
      yield* sleep(0);
      expect(log).toEqual(['ask']);
      gate.resolve();
      yield* sleep(0);
      commands.send({ type: 'ask', text: 'b' });
      yield* sleep(0);
      expect(log, 'the loop went on dispatching after it was told to end').toEqual(['ask', 'until']);
    });
  });

  it('with `onUnhandled`, a command nobody handles goes there and never to onError; "exit" from it ends the loop', async () => {
    const log: string[] = [];
    await run(function* () {
      const commands = createSignal<Command, void>();
      const g = { handlers: { *ask() { log.push('ask'); } } };
      const served = yield* spawn(() => serveCommands(commands, [g], {
        *onError() { log.push('onError'); },
        *onUnhandled(c) { log.push(`unhandled:${c.type}`); return c.type === 'leave' ? 'exit' as const : undefined; },
      }));
      yield* sleep(0);
      commands.send({ type: 'boom' });
      commands.send({ type: 'ask', text: 'still served' });
      commands.send({ type: 'leave' });
      commands.send({ type: 'ask', text: 'never' });
      yield* served;
    });
    expect(log).toEqual(['unhandled:boom', 'ask', 'unhandled:leave']);
  });

  it('a command nobody handles reaches onError, naming its type', async () => {
    const seen: string[] = [];
    await run(function* () {
      const commands = createSignal<Command, void>();
      const g = { handlers: { *ask() {} } };
      const served = yield* spawn(() => serveCommands(commands, [g], {
        *onError(err) { seen.push((err as Error).message); },
      }));
      yield* sleep(0);
      commands.send({ type: 'open', id: 'x' });
      commands.send({ type: 'quit' });
      yield* served;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/open/);
  });
});
