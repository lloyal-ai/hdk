/**
 * The pool's ledger of spawns: one entry per `PoolContext.spawn`, in request
 * order, carrying the spawn's identity across heals. An entry is opened when
 * the spawn is requested, takes an agent when the executor admits it, moves to
 * the replacement when a heal is admitted, and settles once its agent is final
 * with no heal pending — or at once when the spawn is refused before any fork.
 * `waitFor` waits on the entry, so it resolves to the lineage's final agent;
 * `AgentPoolResult.outcomes` reads the entries in order; `byKey` finds one by
 * the application's label, which is refused when repeated within one pool.
 */
import { withResolvers } from 'effection';
import type { Operation } from 'effection';
import type { Agent } from './Agent';
import type { SpawnRefusal } from './state';
import type { SpawnOutcome } from './types';

/** A spawn the pool could not seat, and why. Thrown from `PoolContext.spawn`;
 *  the shapes catch it and read `outcome`, so one refused inquiry does not end
 *  its siblings. A `dag` node lets it propagate: its dependents need it. */
export class SpawnRefused extends Error {
  constructor(readonly reason: SpawnRefusal, readonly outcome: SpawnOutcome, detail?: string) {
    super(`useAgentPool: spawn${outcome.key !== undefined ? ` "${outcome.key}"` : ''} refused: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.name = 'SpawnRefused';
  }
}

export interface SpawnEntry {
  readonly index: number;
  readonly key?: string;
  /** The agent carrying this spawn now: the original, then a heal's replacement. Null until admitted, or when refused. */
  agent: Agent | null;
  /** A refusal before any fork. */
  refused: SpawnRefusal | null;
  /** A heal for this entry has been priced and queued; the entry stays open until it is admitted or stands down. */
  healing: boolean;
  settled: boolean;
  readonly future: ReturnType<typeof withResolvers<void>>;
}

/** The outcome an agent's final state yields for the spawn it carried. */
export function outcomeOfAgent(agent: Agent, key?: string): SpawnOutcome {
  return { key, agentId: agent.id, result: agent.result, exitReason: agent.exitReason, failed: agent.failed };
}

const isFinal = (a: Agent): boolean => a.status === 'idle' || a.status === 'disposed';

export class SpawnLedger {
  private readonly entries: SpawnEntry[] = [];
  private readonly byAgent = new Map<Agent, SpawnEntry>();
  private readonly keys = new Set<string>();

  /** Open an entry for a requested spawn. A key already taken in this pool is refused loud: it is a programming error, not a pool condition. */
  open(key?: string): SpawnEntry {
    if (key !== undefined) {
      if (this.keys.has(key)) throw new Error(`useAgentPool: spawn key "${key}" is already taken in this pool`);
      this.keys.add(key);
    }
    const entry: SpawnEntry = { index: this.entries.length, key, agent: null, refused: null, healing: false, settled: false, future: withResolvers<void>('spawn') };
    this.entries.push(entry);
    return entry;
  }

  at(index: number): SpawnEntry { return this.entries[index]; }
  of(agent: Agent): SpawnEntry | undefined { return this.byAgent.get(agent); }

  /** The executor admitted a fork for the entry: the original, or a heal's replacement. */
  admitted(entry: SpawnEntry, agent: Agent): void {
    entry.agent = agent;
    entry.healing = false;
    this.byAgent.set(agent, entry);
  }

  /** A heal for the entry's agent was priced and queued. */
  healing(entry: SpawnEntry): void { entry.healing = true; }
  /** The heal stood down: the original's failure stands, and the entry may settle. */
  healStoodDown(entry: SpawnEntry): void { entry.healing = false; }

  /** A spawn the pool could not seat. Before any agent, the entry settles as the refusal;
   *  for a heal, the original's failure stands. Returns the outcome either way. */
  refuse(entry: SpawnEntry, reason: SpawnRefusal): SpawnOutcome {
    if (entry.agent === null) {
      entry.refused = reason;
      this.settle(entry);
    } else {
      entry.healing = false;
    }
    return this.outcome(entry);
  }

  /** Settle every open entry whose agent is final with no heal decided or pending. Run once per tick, after the outcomes are applied. */
  settlePass(): void {
    for (const e of this.entries) {
      if (e.settled || e.agent === null || e.healing) continue;
      if (isFinal(e.agent) && e.agent.heal === null) this.settle(e);
    }
  }

  /** Suspend until the entry settles. */
  *settled(entry: SpawnEntry): Operation<void> {
    yield* entry.future.operation;
  }

  outcome(entry: SpawnEntry): SpawnOutcome {
    if (entry.agent === null) return { key: entry.key, agentId: null, result: null, exitReason: undefined, failed: entry.refused };
    return outcomeOfAgent(entry.agent, entry.key);
  }

  outcomes(): SpawnOutcome[] { return this.entries.map((e) => this.outcome(e)); }

  byKey(key: string): SpawnOutcome | undefined {
    const e = this.entries.find((x) => x.key === key);
    return e ? this.outcome(e) : undefined;
  }

  private settle(entry: SpawnEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.future.resolve();
  }
}
