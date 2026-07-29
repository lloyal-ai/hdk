/**
 * The CLI's shared color language — one place so the wizard, the install
 * spinner, and the next-steps panel stay coherent (and don't drift into an
 * all-teal surface). Warm amber for labels / prompts / work-in-progress; cool
 * cyan reserved for LIVE selection only; green for success.
 */
import { extendTheme, defaultTheme } from '@inkjs/ui';

/** Warm accent — question labels, the `❯` prompt, the install spinner. */
export const ACCENT = '#f5a623';
/** The same accent as a raw SGR foreground code, for plain-ANSI output (the
 *  next-steps panel) — derived from ACCENT so the two can never drift. */
export const ACCENT_SGR = `38;2;${parseInt(ACCENT.slice(1, 3), 16)};${parseInt(
  ACCENT.slice(3, 5),
  16,
)};${parseInt(ACCENT.slice(5, 7), 16)}`;
/** The focused/selected row (the one cool accent — kept scarce on purpose). */
const FOCUS = 'cyan';
/** Success / checked. */
const SUCCESS = 'green';

const focusHighlight = (p?: { isFocused?: boolean; isSelected?: boolean }): Record<string, unknown> => {
  if (p?.isFocused) return { color: FOCUS, bold: true };
  if (p?.isSelected) return { color: SUCCESS };
  return {};
};

/**
 * `@inkjs/ui` theme override. Its defaults paint both the focused option AND
 * the spinner frame `blue` — low-contrast on a dark terminal. This recolors
 * selection to cyan+bold, the multi-select check to green, and the spinner to
 * the warm accent so "working" reads clearly.
 */
export const cliTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: FOCUS }),
        label: focusHighlight,
      },
    },
    MultiSelect: {
      styles: {
        focusIndicator: () => ({ color: FOCUS }),
        selectedIndicator: () => ({ color: SUCCESS }),
        label: focusHighlight,
      },
    },
    Spinner: {
      styles: {
        frame: () => ({ color: ACCENT }),
      },
    },
  },
});
