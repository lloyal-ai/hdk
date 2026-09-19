/**
 * `coverage`: what each source covers for a query — one probe per source,
 * in parallel on a shared spine, each searching its own source and reporting
 * which parts it holds. The joined text is what a planner routes with: it
 * routes by TRYING the sources, not by their descriptions. A probe is shallow
 * and its turn cap is firm: past `budget.maxTurns` the probe is reaped and its
 * coverage recovered, so a source always answers with a line instead of a loop.
 * The caller memoises (a query asked again with more context is not probed
 * again) and says what it means on its own wire.
 *
 * @category Rig
 */
import type { Operation } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import { agentPool, parallel, withSpine, DefaultAgentPolicy, budgetPolicyOpts } from '@lloyal-labs/lloyal-agents';
import type { Ability, Agent, Budget, ContextPressure, GuardOverrides, PromptOf, ToolLifecycleHooks } from '@lloyal-labs/lloyal-agents';
import type { Attachment } from '@lloyal-labs/media';
import { reportTool } from './tools';
import { renderSpine } from './spine-render';
import { abilityToc } from './participating';

export interface CoverageOptions {
  /** What the sources are probed for. */
  query: string;
  /** The sources to probe, one agent each. */
  sources: readonly Ability[];
  /** The branch the spine forks from; absent: a cold spine. */
  parent?: Branch;
  /** The probe's prompt, asked once per source with what a probe is about: the query and the source
   *  as the model sees it (its protocol name, when to use it, its tools, and the contents it holds for this run). */
  prompt: PromptOf<CoveragePromptInput>;
  /** The probe's row: `recovery` says what a probe reaped before reporting is told, and `maxTurns` is FIRM here — a probe past it is reaped, not nudged. */
  budget: Budget;
  /** The harness's scope for the sources' gates. */
  guards?: GuardOverrides;
  /** The harness's lifecycle contributions (an evidence floor). */
  hooks?: readonly ToolLifecycleHooks[];
  /** The run's assets: what each source advertises for them, and what the probes may read. */
  reference?: readonly Attachment[];
}

/** What a probe's prompt is called with: the query, and the one source this probe reads. */
export interface CoveragePromptInput {
  query: string;
  ability: { name: string; useWhen: string; tools: readonly string[]; contents: string | null };
}

export interface Coverage {
  /** `### <protocol>` then that source's report, per source that reported, in source order. */
  coverage: string;
  tokens: number;
  toolCalls: number;
  timeMs: number;
}

/** The key a probe's spawn carries (`agent:spawn.key`): it names the SOURCE the probe reads, so a view can label
 *  the probe by reading it back, whatever order the pool seats the probes in. */
export const sourceKey = (name: string): string => `source:${name}`;
/** The source a probe's key names; null for a spawn that is not a probe's. */
export const sourceOf = (key: string | undefined): string | null => (key?.startsWith('source:') ? key.slice('source:'.length) : null);

/** The default policy with a firm turn cap: `shouldExit` at the cap, where the default only nudges. */
class ProbePolicy extends DefaultAgentPolicy {
  constructor(opts: ConstructorParameters<typeof DefaultAgentPolicy>[0], private readonly cap: number | undefined) {
    super(opts);
  }
  override shouldExit(agent: Agent, pressure: ContextPressure): boolean {
    if (this.cap !== undefined && agent.turns >= this.cap) return true;
    return super.shouldExit(agent, pressure);
  }
}

export function* coverage(opts: CoverageOptions): Operation<Coverage> {
  const t0 = performance.now();
  const reference = opts.reference ?? [];
  const tools = [...opts.sources.flatMap((a) => [...a.tools]), reportTool];
  const policy = new ProbePolicy(
    budgetPolicyOpts(opts.budget, { terminalToolName: reportTool.name, guardOverrides: opts.guards, hooks: opts.hooks }),
    opts.budget.maxTurns,
  );
  return yield* withSpine<Coverage>(
    { parent: opts.parent, systemPrompt: renderSpine({ abilities: opts.sources, reference }), tools },
    function* (spine) {
      const probe = yield* agentPool({
        parent: spine, tools, terminal: reportTool, attachments: reference,
        maxTurns: opts.budget.maxTurns, policy,
        orchestrate: parallel(opts.sources.map((ability, i) => ({
          ...opts.prompt({
            query: opts.query,
            ability: {
              name: ability.manifest.protocol.name, useWhen: ability.manifest.protocol.useWhen,
              tools: ability.manifest.protocol.tools, contents: abilityToc(ability, reference),
            },
          }),
          key: sourceKey(ability.manifest.name),
          assignedAbility: ability.manifest.name,
          seed: 2000 + i,
        }))),
      });
      const lines = opts.sources
        .map((ability) => ({ name: ability.manifest.protocol.name, body: probe.byKey(sourceKey(ability.manifest.name))?.result?.trim() }))
        .filter((l): l is { name: string; body: string } => !!l.body)
        .map((l) => `### ${l.name}\n${l.body}`);
      return { coverage: lines.join('\n\n'), tokens: probe.totalTokens, toolCalls: probe.totalToolCalls, timeMs: performance.now() - t0 };
    },
  );
}
