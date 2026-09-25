import { Eta } from 'eta';

const eta = new Eta({ autoEscape: false });

/** A key a template read that its input did not name. */
export interface MissingInput {
  /** The template's name, as the caller knows it — a prompt's file, an ability's skill. */
  prompt: string;
  key: string;
}

/**
 * A template's input, held to what it was given. A template declares its inputs in the one place that cannot
 * drift — the keys it reads — so a key it reads that the input did not name is a MISSING INPUT: reported to
 * `onMissing`, and read as the empty string, never as the word "undefined" in the text a model reads. What
 * `onMissing` does is the caller's: a test throws, so a typo in a template fails there; a run notes it and goes
 * on, so an edge the framework misfires never costs a reader the run. A key given as `undefined` is given.
 *
 * @category Agents
 */
export function guardedInput(prompt: string, data: Record<string, unknown>, onMissing: (miss: MissingInput) => void): Record<string, unknown> {
  return new Proxy(data, {
    get(target, key) {
      if (typeof key === 'symbol' || key in target) return target[key as string];
      onMissing({ prompt, key });
      return '';
    },
  });
}

/** The default for a render nobody watches: the engine's log, once per line. */
const warn = ({ prompt, key }: MissingInput): void => { console.warn(`[prompt] ${prompt}: input "${key}" is not given — rendered empty`); };

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
 * The data is held to the template ({@link guardedInput}): a key the template reads and the data does not
 * name is reported — to `opts.onMissing`, else the engine's log — and rendered empty.
 *
 * @param template - Eta template string
 * @param data - Variables available as `it.*` in the template
 * @param opts - `name`: what a report calls this template; `onMissing`: what a missing input does
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
  opts: { name?: string; onMissing?: (miss: MissingInput) => void } = {},
): string => eta.renderString(template, guardedInput(opts.name ?? 'template', data, opts.onMissing ?? warn));
