/**
 * The served host's per-connection seam: one `ws` connection is one Session
 * over the resident model. The driver assembles `@lloyal-labs/host`'s
 * `ServedHarness { materialise, run }`, drives a `ModelRuntimeHost` (ONE
 * resident model → N Sessions), and binds each connection to a Session over
 * binding's `wss()`.
 *
 * **Eager channels**: `wss()` needs the bus and the commands at bind time, but
 * the host materialises asynchronously; the driver creates the channels per
 * connection and `materialise` claims those SAME channels, so the socket binds
 * once, at connect time, and the harness's events flow through the
 * already-subscribed bus. **A dead session says why**: a harness that throws
 * is isolated to its session by the host, and the reason is written to the
 * host's log here, since the host itself swallows it.
 *
 * @category Runtime
 */
import { randomUUID } from 'node:crypto';
import { resource } from 'effection';
import type { Operation, Signal } from 'effection';
import { createModelRuntimeHost } from '@lloyal-labs/host';
import type { Materialised, ServedHarness, SessionState } from '@lloyal-labs/host';
import { wss } from '@lloyal-labs/binding/node';
import type { WsServerSocket } from '@lloyal-labs/binding/node';
import { createBus } from '@lloyal-labs/binding';
import type { EventBus } from '@lloyal-labs/binding';
import type { SessionContext } from '@lloyal-labs/sdk';
import { bufferedCommandSignal } from './buffered-command-signal';

export interface ServedChannels<E, C> {
  uiChannel: EventBus<E>;
  commands: Signal<C, void>;
}

/** A fresh per-session event bus and command signal. */
export function createServedChannels<E, C>(): ServedChannels<E, C> {
  return { uiChannel: createBus<E>(), commands: bufferedCommandSignal<C>() };
}

export interface ServedHostDriverOpts<E, C> {
  maxNativeSessions: number;
  /** Build the per-session context over the resident model. */
  buildContext: () => Promise<SessionContext>;
  /** Run one Session's harness over its substrate — the app's `harness`, under the runner the boot builds. */
  run: (m: Materialised<SessionContext> & ServedChannels<E, C>, sessionId: string) => Operation<void>;
  /** Where a session's fate is written. Default: the console. */
  log?: (line: string) => void;
}

export interface ServedHostDriver {
  /** Bind one `ws` connection to a fresh Session. Call from `server.on("connection")`. */
  serveConnection(socket: WsServerSocket): void;
  /** Live-session occupancy (the host ledger). */
  readonly occupancy: number;
}

/**
 * Create the driver as an Effection resource: the host lives for the
 * resource's scope; unwinding it halts every Session and frees every context.
 */
export function createServedHostDriver<E, C>(opts: ServedHostDriverOpts<E, C>): Operation<ServedHostDriver> {
  const log = opts.log ?? ((line: string) => console.error(line));
  return resource(function* (provide) {
    // Channels a connection stashes BEFORE admission; `materialise` CLAIMS them (returns them AND removes the
    // entry) so the socket, bound at connect time, and the harness share one bus/command pair.
    const pending = new Map<string, ServedChannels<E, C>>();
    const reasons = new Map<string, string>();

    const served: ServedHarness<SessionContext> = {
      async materialise(sessionId: string): Promise<Materialised<SessionContext>> {
        const ch = pending.get(sessionId);
        if (!ch) throw new Error(`serve: no channels for session ${sessionId}`);
        pending.delete(sessionId);
        const context = await opts.buildContext();
        return {
          context,
          uiChannel: ch.uiChannel as EventBus<unknown>,
          commands: ch.commands as Signal<unknown, void>,
          dispose() {
            try { context.dispose?.(); } catch { /* freeing the served context — not the driver's error to surface */ }
          },
        };
      },
      *run(m, sessionId) {
        // The host swallows a harness that throws (`died`); the reason is kept here so the session's log says why.
        try {
          yield* opts.run(m as Materialised<SessionContext> & ServedChannels<E, C>, sessionId);
        } catch (err) {
          reasons.set(sessionId, err instanceof Error ? (err.stack ?? err.message) : String(err));
          throw err;
        }
      },
    };

    const host = yield* createModelRuntimeHost<SessionContext>({ served, maxNativeSessions: opts.maxNativeSessions });

    function serveConnection(socket: WsServerSocket): void {
      const sessionId = randomUUID();
      // An unhandled 'error' on a Node socket throws and would take the whole process down.
      (socket as unknown as { on?: (event: 'error', cb: () => void) => void }).on?.('error', () => {});
      try {
        const channels = createServedChannels<E, C>();
        pending.set(sessionId, channels);
        const postSession = wss<E, C>(socket, {
          uiChannel: channels.uiChannel,
          dispatch: (c) => channels.commands.send(c),
          bootstrap: [],
          sessionId,
        });
        socket.on('close', () => {
          host.release(sessionId).catch(() => {});
        });
        host.admit({
          sessionId,
          onState: (s: SessionState) => {
            postSession(s);
            if (s.phase === 'died') {
              log(`[serve] session ${sessionId} died: ${reasons.get(sessionId) ?? 'the context could not be built'}`);
            }
            if (s.phase === 'reaped' || s.phase === 'died') {
              pending.delete(sessionId);
              reasons.delete(sessionId);
            }
          },
        });
      } catch (err) {
        // Contain a synchronous setup failure to THIS connection.
        pending.delete(sessionId);
        host.release(sessionId).catch(() => {});
        (socket as { close?: () => void }).close?.();
        log(`[serve] connection setup failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    yield* provide({
      serveConnection,
      get occupancy() {
        return host.occupancy;
      },
    });
  });
}
