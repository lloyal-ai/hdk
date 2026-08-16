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
import type {
  Ability,
  AgentRenderCtx,
  SkillTemplateFn,
  ExamplesRenderCtx,
  ExamplesTemplateFn,
} from '@lloyal-labs/lloyal-agents';
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

  return (
    FRAMEWORK_INTRO +
    '\n\n# Protocols\n\n' +
    catalogBlocks +
    '\n' +
    TOOL_SELECTION_RULE
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
 * `params` accepts ability-specific render data beyond {@link AgentRenderCtx}
 * (e.g. a corpus ability merges its `source.promptData()` to supply `it.toc`).
 * Extra keys are spread into the Eta render data unchanged.
 */
export function renderAgentPreamble(
  ability: Ability,
  params: AgentRenderCtx & Record<string, unknown>,
): string {
  const marker = BOUNDARY_MARKER(ability.manifest.protocol.name);
  const body = renderSkillBody(ability.skill, params);

  if (!ability.examples) {
    return marker + body;
  }

  const examplesParams: ExamplesRenderCtx = {
    ...params,
    name: ability.manifest.protocol.name,
    tools: ability.manifest.protocol.tools,
  };
  const examples = renderExamples(ability.examples, examplesParams);
  return marker + body + '\n\n' + examples;
}

function renderSkillBody(
  skill: string | SkillTemplateFn,
  params: AgentRenderCtx,
): string {
  return typeof skill === 'function'
    ? skill(params)
    : renderTemplate(skill, params as unknown as Record<string, unknown>);
}

function renderExamples(
  examples: string | ExamplesTemplateFn,
  params: ExamplesRenderCtx,
): string {
  return typeof examples === 'function'
    ? examples(params)
    : renderTemplate(examples, params as unknown as Record<string, unknown>);
}
