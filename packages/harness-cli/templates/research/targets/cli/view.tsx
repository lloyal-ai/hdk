/**
 * The terminal view — a `render`-style binding: `(bus, dispatch, bootstrap) =>
 * dispose`. It subscribes to your events, folds them through the REAL research
 * `reduce` (harness/state.ts), and renders an austere slice of the rich
 * `AppState`: the phase, the live agents, a KV gauge, and the streaming answer.
 *
 * Austere on purpose. reasoning.run's own UI is a 19-component Ink suite with a
 * plan-review editor, a sources ledger, and a settings drawer; this view folds
 * the SAME state through a handful of lines. It auto-accepts the planner's plan
 * (no interactive plan-review here) so a query runs recon → plan → agents →
 * synth end-to-end. Swap it, or grow it, or bring a whole app — the harness
 * never changes; the framework holds the binding seam, never the UI.
 */
import React, { useEffect, useReducer, useRef } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { EventBus } from "@lloyal-labs/binding";
import { initialState, reduce } from "../../harness/state.js";
import type { AgentRuntime, AppState } from "../../harness/state.js";
import type { Command, WorkflowEvent } from "../../harness/protocol.js";

const seed = (bootstrap: WorkflowEvent[]): AppState =>
  bootstrap.reduce(reduce, initialState);

const glyph = (p: AgentRuntime["phase"]): string =>
  p === "done" ? "✓" : p === "failed" ? "✗" : p === "tool" ? "◍" : p === "idle" ? "·" : "●";

/** Where the input line is offered — the harness is idle and awaiting a query. */
const CAN_INPUT = new Set<AppState["uiPhase"]>(["boot", "composer", "done", "clarifying"]);

function Gauge({ used, total }: { used: number; total: number }): React.ReactElement | null {
  if (!total) return null;
  const pct = Math.min(100, Math.round((100 * used) / total));
  const width = 16;
  const filled = Math.round((pct / 100) * width);
  return (
    <Text color="gray">
      KV {"█".repeat(filled)}
      {"░".repeat(width - filled)} {pct}%
    </Text>
  );
}

function View({
  bus,
  dispatch,
  bootstrap,
}: {
  bus: EventBus<WorkflowEvent>;
  dispatch: (c: Command) => void;
  bootstrap: WorkflowEvent[];
}): React.ReactElement {
  const [state, apply] = useReducer(reduce, bootstrap, seed);
  const app = useApp();
  const acceptedRef = useRef(false);

  useEffect(() => bus.subscribe((ev) => apply(ev)), [bus]);

  // Auto-accept the planner's plan — this austere view has no plan-review editor,
  // so a query flows straight through to research. `acceptedRef` de-bounces the
  // one transition into `plan_review`.
  useEffect(() => {
    if (state.uiPhase === "plan_review" && !acceptedRef.current) {
      acceptedRef.current = true;
      dispatch({ type: "accept_plan" });
    }
    if (state.uiPhase !== "plan_review") acceptedRef.current = false;
  }, [state.uiPhase, dispatch]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      dispatch({ type: "quit" });
      app.exit();
    }
  });

  // Recon + research agents (skip the tool-less synth agent — taskIndex null).
  const agents = [...state.agents.values()].filter((a) => a.taskIndex !== null);

  // The streaming answer: the live synth buffer, else the finalized answer, else
  // the most recent synth body pushed to scrollback.
  const lastSynth = [...state.scrollback].reverse().find((s) => s.kind === "synth");
  const streaming =
    (state.synth.open && state.synth.buffer) ||
    state.answer ||
    (lastSynth && lastSynth.kind === "synth" ? lastSynth.body : "");

  const canInput = CAN_INPUT.has(state.uiPhase);

  const onSubmit = (q: string): void => {
    const text = q.trim();
    if (!text) return;
    if (state.uiPhase === "clarifying") {
      dispatch({ type: "submit_clarification", answer: text });
    } else {
      dispatch({ type: "submit_query", query: text, mode: "flat" });
    }
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{"__NAME__"}</Text>
        <Text color="gray">Model      resident · no API key</Text>
        <Text color="gray">Inference  local · no provider</Text>
        <Text color="gray">
          Phase      {state.phase}
          {state.uiPhase !== state.phase ? ` · ${state.uiPhase}` : ""}
        </Text>
      </Box>

      {agents.length > 0 && (
        <Box flexDirection="column">
          {agents.map((a) => (
            <Text key={a.id}>
              {glyph(a.phase)} {a.label}
              {a.taskDescription ? ` · ${a.taskDescription}` : ""} · {a.tokenCount} tok
              {a.toolCallCount > 0 ? ` · ${a.toolCallCount} tools` : ""}
            </Text>
          ))}
          {state.pressure && (
            <Gauge used={state.pressure.cellsUsed} total={state.pressure.nCtx} />
          )}
        </Box>
      )}

      {state.uiPhase === "clarifying" && state.plan?.clarifyQuestions?.length ? (
        <Box flexDirection="column">
          <Text color="yellow">The planner needs to clarify:</Text>
          {state.plan.clarifyQuestions.map((q, i) => (
            <Text key={i} color="yellow">
              {"  "}
              {i + 1}. {q}
            </Text>
          ))}
        </Box>
      ) : null}

      {streaming ? <Text color="cyan">{streaming}</Text> : null}
      {state.bootError && (
        <Text color="red">boot error ({state.bootError.kind}): {state.bootError.message}</Text>
      )}
      {state.toast?.tone === "error" && <Text color="red">error: {state.toast.message}</Text>}

      {canInput && (
        <Box>
          <Text color="green">› </Text>
          <TextInput
            placeholder={
              state.uiPhase === "clarifying"
                ? "answer the planner, ctrl-c to stop"
                : "type a question, ctrl-c to stop"
            }
            onSubmit={onSubmit}
          />
        </Box>
      )}
    </Box>
  );
}

export function renderCli(
  bus: EventBus<WorkflowEvent>,
  dispatch: (c: Command) => void,
  bootstrap: WorkflowEvent[],
): () => void {
  const instance = render(<View bus={bus} dispatch={dispatch} bootstrap={bootstrap} />);
  return () => instance.unmount();
}
