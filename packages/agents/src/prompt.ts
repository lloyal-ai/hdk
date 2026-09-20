import { Eta } from 'eta';

const eta = new Eta({ autoEscape: false });

/**
 * Render a template string with Eta. Templates use standard Eta/EJS
 * syntax: `<%= it.var %>` for interpolation, `<% if (it.x) { %>` for
 * conditionals, `<% it.arr.forEach(...) %>` for loops.
 *
 * Auto-escaping is disabled — templates produce prompt text, not HTML.
 *
 * This renders text an ABILITY ships (its skills and examples, through rig);
 * an app's own prompts are rendered by the app and handed to the framework
 * as functions of what the framework knows ({@link PromptOf}).
 *
 * @param template - Eta template string
 * @param data - Variables available as `it.*` in the template
 * @returns Rendered string
 *
 * @example
 * ```typescript
 * const result = renderTemplate(
 *   'Hello <%= it.name %><% if (it.age) { %>, age <%= it.age %><% } %>',
 *   { name: 'Alice', age: 30 },
 * );
 * // => "Hello Alice, age 30"
 * ```
 *
 * @category Agents
 */
export const renderTemplate = (
  template: string,
  data: Record<string, unknown>,
): string => eta.renderString(template, data);
