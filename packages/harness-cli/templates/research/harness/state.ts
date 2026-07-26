/**
 * How a view *accumulates* your events into renderable state — the
 * renderer-neutral state surface.
 *
 * The pure `reduce` + `AppState` (and the state vocabulary) with NO Ink/React
 * dependency, so every target view — the terminal (Ink), and later the desktop
 * and web (React) — imports this ONE `reduce`. Only the small raw
 * `WorkflowEvent` crosses a target boundary; the growing transcript never does,
 * so the fold happens in the *sink*. The harness stays a pure emitter; each
 * renderer stays a pure sink. Node-free so every runtime can import it.
 */
export { reduce } from "./reducer.js";
export * from "./state-core.js";
