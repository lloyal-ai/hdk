/**
 * `Session.userSidePending` — whether the trunk's last turn is a user side
 * awaiting its answer: the fact `prefillAssistant` closes. The Session owns it
 * because it is decided where the native call resolves. A consumer that
 * shadows it in a flag assigned after `yield* waitUntilSettled(...)` is wrong
 * under a halt: the halt lets the prefill land and the assignment never runs.
 *
 * The transitions, and the one property beyond them: the fact is recorded by
 * the method's own continuation, whether or not anyone awaits its promise.
 */
import { describe, it, expect } from 'vitest';
import { BranchStore, Session } from '../src/index';
import { MockSessionContext } from '../src/testing.js';
import type { SessionContext } from '../src/types';

function makeSession() {
  const mock = new MockSessionContext();
  const ctx = mock as unknown as SessionContext;
  const store = new BranchStore(ctx);
  const session = new Session({ ctx, store });
  return { mock, session };
}

describe('Session.userSidePending', () => {
  it('is false with no trunk, and after a committed pair', async () => {
    const { session } = makeSession();
    expect(session.userSidePending).toBe(false);
    await session.commitTurn('q', 'a');
    expect(session.userSidePending).toBe(false);
  });

  it('prefillUser opens the side; prefillAssistant closes it', async () => {
    const { session } = makeSession();
    await session.commitTurn('q', 'a');
    await session.prefillUser('follow-up');
    expect(session.userSidePending).toBe(true);
    await session.prefillAssistant('answer');
    expect(session.userSidePending).toBe(false);
  });

  it('commitTurn, dispose and the trunk setter each leave no open side', async () => {
    const { session } = makeSession();
    await session.commitTurn('q', 'a');
    await session.prefillUser('u1');
    await session.commitTurn('q2', 'a2');
    expect(session.userSidePending).toBe(false);

    await session.prefillUser('u2');
    await session.dispose();
    expect(session.userSidePending).toBe(false);

    await session.commitTurn('q3', 'a3');
    await session.prefillUser('u3');
    session.trunk = null;
    expect(session.userSidePending).toBe(false);
  });

  it('prefillUserMultimodal opens the side; a poisoned multimodal prefill leaves no trunk and no side', async () => {
    const { mock, session } = makeSession();
    await session.commitTurn('q', 'a');
    await session.prefillUserMultimodal('look', [new Uint8Array([1, 2, 3])]);
    expect(session.userSidePending).toBe(true);
    await session.prefillAssistant('seen');

    mock.mockMultimodalError = () => 'bad image';
    await expect(session.prefillUserMultimodal('again', [new Uint8Array([9])])).rejects.toThrow('bad image');
    expect(session.trunk).toBeNull();
    expect(session.userSidePending).toBe(false);
  });

  it('prefillAligned opens the side', async () => {
    const { session } = makeSession();
    await session.commitTurn('q', 'a');
    await session.prefillAligned('align', []);
    expect(session.userSidePending).toBe(true);
  });

  it('is recorded by the call itself, with no awaiter — the halted case', async () => {
    const { session } = makeSession();
    await session.commitTurn('q', 'a');
    void session.prefillUser('follow-up'); // nobody awaits: the generator that issued it was halted
    await new Promise((r) => setImmediate(r));
    expect(session.userSidePending).toBe(true);
  });
});
