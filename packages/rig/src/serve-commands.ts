/**
 * The dispatcher: one loop over the command signal, one handler per command
 * type, the handlers merged from the groups the application composes.
 *
 * A group is a part of the application — `{ handlers, ...methods }` — and the
 * dispatcher reads only its `handlers`. Two groups claiming one command type
 * is refused before the first command is read. Each handler runs under its own
 * `scoped()` boundary, so what it spawns ends when it returns; a handler hands
 * long work to the execution owner and returns, and never waits for the owner
 * to be idle, which is what keeps this loop dispatching a Stop during the
 * slowest cleanup. `"exit"` from a handler, or from `onError`, ends the loop;
 * `quit` is the dispatcher's own and needs no group. A handler that throws
 * reaches `onError`; without one the error ends the loop, since nothing else
 * could report it. A command nobody handles is a different fact — a view wired
 * to something the application never offered — and reaches `onUnhandled` when
 * there is one, so the application need not tell the two apart by inspecting
 * an error; without one it reaches `onError` as an error naming the type.
 *
 * @category Rig
 */
import { each, race, scoped } from 'effection';
import type { Operation, Signal } from 'effection';

/** What a handler, or `onError`, may return: `"exit"` ends the loop. */
export type Flow = 'exit' | void;

/** One handler per command type the group owns. */
export type Handlers<C extends { type: string }> = {
  [K in C['type']]?: (command: Extract<C, { type: K }>) => Operation<Flow>;
};

/** A part of the application, as the dispatcher sees it. */
export interface CommandGroup<C extends { type: string }> {
  handlers: Handlers<C>;
}

export interface ServeCommandsOptions<C extends { type: string } = { type: string }> {
  /** A handler threw — or, with no `onUnhandled`, a command had no handler. Return `"exit"` to end the loop. */
  onError?: (err: unknown) => Operation<Flow>;
  /** A command arrived that no group handles. Return `"exit"` to end the loop. */
  onUnhandled?: (command: C) => Operation<Flow>;
  /**
   * Ends the loop when it settles — for a fact no command carries.
   *
   * The loop suspends on the next command, so without this the only way out is
   * a command; an execution owner that poisoned is exactly a fact no command
   * carries, and a reader should not have to ask a question to discover their
   * session is over. Whatever this operation does before settling — saying why,
   * on the wire — happens first.
   */
  until?: Operation<unknown>;
}

/**
 * Serve `commands` with the groups' handlers until `quit`, an `"exit"`, or an
 * error nobody handles.
 */
export function* serveCommands<C extends { type: string }>(
  commands: Signal<C, void>,
  groups: readonly CommandGroup<C>[],
  opts: ServeCommandsOptions<C> = {},
): Operation<void> {
  const table = new Map<string, (command: C) => Operation<Flow>>();
  for (const group of groups) {
    for (const [type, handler] of Object.entries(group.handlers)) {
      if (!handler) continue;
      if (table.has(type)) throw new Error(`serveCommands: two groups handle "${type}"`);
      table.set(type, handler as (command: C) => Operation<Flow>);
    }
  }
  // The table is built before either arm starts, so a duplicate is still refused before the first
  // command is read — and before `until` could end a loop that was never going to run.
  if (opts.until) {
    yield* race([dispatch(commands, table, opts), opts.until as Operation<void>]);
    return;
  }
  yield* dispatch(commands, table, opts);
}

function* dispatch<C extends { type: string }>(
  commands: Signal<C, void>,
  table: Map<string, (command: C) => Operation<Flow>>,
  opts: ServeCommandsOptions<C>,
): Operation<void> {
  for (const command of yield* each(commands)) {
    if (command.type === 'quit') return;
    let flow: Flow;
    try {
      const handler = table.get(command.type);
      if (handler) flow = yield* scoped(() => handler(command));
      else if (opts.onUnhandled) flow = yield* opts.onUnhandled(command);
      else throw new Error(`serveCommands: no handler for "${command.type}"`);
    } catch (err) {
      if (!opts.onError) throw err;
      flow = yield* opts.onError(err);
    }
    // The exit check precedes `each.next()`: next() suspends until the next
    // command arrives, and a return through that suspension would leave one
    // command late.
    if (flow === 'exit') return;
    yield* each.next();
  }
}
