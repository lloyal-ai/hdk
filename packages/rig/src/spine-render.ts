/**
 * Spine + per-spawn preamble assembly.
 *
 * Two pure render functions. Both pull bytes from `protocol.ts`
 * constants rather than inlining literals — the codified protocol
 * has exactly one source of truth.
 *
 * ## `renderSpine`
 *
 * Assembles the Level-1 shared-prefix system prompt. **Carries no
 * free-form prose surface**: framework-owned literal strings +
 * grammar-sanitized ability catalog metadata. No `supplementaryContent`
 * parameter, no per-ability prose argument.
 *
 * Output structure:
 *
 * ```
 * <FRAMEWORK_INTRO>
 *
 * # Protocols
 *
 * <CATALOG_ENTRY for each ability, in registration order>
 *
 * <TOOL_SELECTION_RULE>
 * ```
 *
 * Ability `examples.eta` content goes through `renderAgentPreamble` into
 * per-spawn preambles, never into this output.
 *
 * ## `renderAgentPreamble`
 *
 * The *only* place the framework emits the boundary marker.
 * Called once per spawn with the assigned ability's templates only — no
 * other ability's `skill.eta` / `examples.eta` enters this rendering, which
 * is what makes per-spawn isolation a framework invariant rather than
 * a convention.
 *
 * @packageDocumentation
 * @category Protocol
 */

import { renderTemplate } from '@lloyal-labs/lloyal-agents';
import type { Ability, AgentRenderCtx, SkillTemplateFn, ExamplesRenderCtx, ExamplesTemplateFn } from './ability-types';
import type { Attachment } from '@lloyal-labs/media';
import { abilityToc } from './participating';
import {
  BOUNDARY_MARKER,
  CATALOG_ENTRY,
  FRAMEWORK_INTRO,
  TOOL_SELECTION_RULE,
} from './protocol';

/**
 * Arguments for {@link renderSpine}. `abilities` order is observable to
 * the model — catalog entries emit in registration order; harness
 * registration order is the input order here.
 */
export interface RenderSpineOptions {
  /**
   * Registered abilities to compose into the catalog. Pass
   * `registry.enabled()` from {@link AbilityRegistryCtx}, or any
   * subset/ordering the harness wants reflected in the spine.
   */
  abilities: readonly Ability[];
  /**
   * The run's reference material: each ability's content advert for these
   * assets (`abilityToc`) is appended to the catalog as one block per
   * ability, rendered once and prefix-shared by every fork instead of
   * repeated in each spawn's suffix. Trusting an ability's advert into the
   * shared prefix is the harness's call, made by passing this. Absent: no
   * ability prose reaches the spine.
   */
  reference?: readonly Attachment[];
}

/**
 * Render the shared-spine system prompt.
 *
 * The output has a fixed shape across pool sizes and pool composition
 * — the only variability is the per-ability catalog block, sourced from
 * each ability's `manifest.protocol`. No ability prose; no harness prose.
 *
 * The returned string is intended for `SpineOptions.systemPrompt` in
 * `withSpine(...)`; tool schemas pass through `SpineOptions.tools =
 * abilities.flatMap(a => a.tools)` separately and are decoded into KV at
 * spine prefill.
 */
export function renderSpine(opts: RenderSpineOptions): string {
  const catalogBlocks = opts.abilities
    .map((ability) =>
      CATALOG_ENTRY(
        ability.manifest.protocol.name,
        [...ability.manifest.protocol.tools],
        ability.manifest.protocol.useWhen,
      ),
    )
    .join('\n');

  const reference = opts.reference
    ? opts.abilities
        .map((ability) => ({ name: ability.manifest.protocol.name, toc: abilityToc(ability, opts.reference) }))
        .filter((b): b is { name: string; toc: string } => !!b.toc && b.toc.trim() !== '')
        .map((b) => `\n\n# ${b.name} — available files\n${b.toc}`)
        .join('')
    : '';
  return (
    FRAMEWORK_INTRO +
    '\n\n# Protocols\n\n' +
    catalogBlocks +
    '\n' +
    TOOL_SELECTION_RULE +
    reference
  );
}

/**
 * Render the per-spawn preamble for a single agent assigned to
 * `ability`. The framework calls this when constructing a spawn's
 * user-role message; the output is the *only* place the boundary
 * marker bytes appear at runtime.
 *
 * Output:
 *
 * ```
 * <BOUNDARY_MARKER(ability.manifest.protocol.name)>
 * <renderTemplate(ability.skill, params)>
 *
 * <renderTemplate(ability.examples, examplesParams)>   // if ability.examples is defined
 * ```
 *
 * `ability.manifest.protocol.name` is grammar-restricted at `defineAbility`
 * time: matches `[a-z][a-z0-9_-]{1,63}`, so it cannot
 * break the markdown bold or inject newlines into the marker bytes.
 *
 * `ability.examples` (if present) receives an extended render context
 * carrying the protocol `name` and `tools[]` in addition to the
 * standard {@link AgentRenderCtx} fields, allowing discipline content
 * to reference the protocol identity directly.
 *
 * The render context defaults to one agent on its own task, today, under the
 * pool's default turn cap; pass any {@link AgentRenderCtx} field to say
 * otherwise, and ability-specific render data beyond it (e.g. a corpus ability
 * merges its `source.promptData()` to supply `it.toc`). Extra keys are spread
 * into the Eta render data unchanged.
 */
export function renderAgentPreamble(
  ability: Ability,
  given: Partial<AgentRenderCtx> & Record<string, unknown> = {},
): string {
  // One agent on its own task, today, under the pool's default turn cap — unless told otherwise.
  const params: AgentRenderCtx & Record<string, unknown> = {
    agentCount: 1,
    siblingTasks: [],
    maxTurns: 100,
    date: new Date().toISOString().slice(0, 10),
    taskIndex: 0,
    ...given,
  };
  const marker = BOUNDARY_MARKER(ability.manifest.protocol.name);
  const body = renderSkillBody(ability.skill, params, `${ability.manifest.name} skill`);

  if (!ability.examples) {
    return marker + body;
  }

  const examplesParams: ExamplesRenderCtx = {
    ...params,
    name: ability.manifest.protocol.name,
    tools: ability.manifest.protocol.tools,
  };
  const examples = renderExamples(ability.examples, examplesParams, `${ability.manifest.name} examples`);
  return marker + body + '\n\n' + examples;
}

function renderSkillBody(
  skill: string | SkillTemplateFn,
  params: AgentRenderCtx,
  name: string,
): string {
  // A template of the ability's own reads a guarded input: a key it reads that the frame does not give is
  // reported under the ability's name and rendered empty, never the word "undefined" on the spine.
  return typeof skill === 'function'
    ? skill(params)
    : renderTemplate(skill, params as unknown as Record<string, unknown>, { name });
}

function renderExamples(
  examples: string | ExamplesTemplateFn,
  params: ExamplesRenderCtx,
  name: string,
): string {
  return typeof examples === 'function'
    ? examples(params)
    : renderTemplate(examples, params as unknown as Record<string, unknown>, { name });
}
