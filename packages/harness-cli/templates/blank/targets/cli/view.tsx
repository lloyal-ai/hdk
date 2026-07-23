/**
 * The terminal view — a `render`-style binding: `(bus, dispatch, bootstrap) =>
 * dispose`. It subscribes to your events, folds them through `reduce`
 * (state.ts), and renders the standard `AppState`. It knows nothing about your
 * domain — swap it, or grow it, or keep it; the harness never changes.
 *
 * Austere on purpose: a header, the agent list, a KV gauge, the streaming
 * answer, an input line. This is the floor, not a ceiling — a real surface can
 * be an entire React/Vite/Next app; the framework holds the binding seam
 * (events ↓ / commands ↑ / `reduce`), never the UI.
 */
import React, { useEffect, useReducer } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { EventBus } from "@lloyal-labs/binding";
import { initialState, reduce } from "../../harness/state.js";
import type { AgentView, AppState } from "../../harness/state.js";
import type { Command, WorkflowEvent } from "../../harness/protocol.js";

const seed = (bootstrap: WorkflowEvent[]): AppState =>
  bootstrap.reduce(reduce, initialState);

const glyph = (s: AgentView["status"]): string =>
  s === "active" ? "●" : s === "tool" ? "◍" : s === "done" ? "✓" : "✗";

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

  useEffect(() => bus.subscribe((ev) => apply(ev)), [bus]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      dispatch({ type: "quit" });
      app.exit();
    }
  });

  const working = state.phase === "working";
  const agents = [...state.agents.values()];
  const streaming =
    state.answer ||
    agents
      .filter((a) => a.status !== "failed")
      .map((a) => a.body)
      .join("")
      .trim();

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{"__NAME__"}</Text>
        <Text color="gray">Model      resident · no API key</Text>
        <Text color="gray">Inference  local · no provider</Text>
        <Text color="gray">Surface    cli</Text>
      </Box>

      {agents.length > 0 && (
        <Box flexDirection="column">
          {agents.map((a) => (
            <Text key={a.id}>
              {glyph(a.status)} agent {a.id}
              {a.currentTool ? ` · ${a.currentTool}` : ""} · {a.tokens} tok
            </Text>
          ))}
          <Gauge used={state.kv.used} total={state.kv.total} />
        </Box>
      )}

      {streaming && <Text color="cyan">{streaming}</Text>}
      {state.error && <Text color="red">error: {state.error}</Text>}

      {!working && (
        <Box>
          <Text color="green">› </Text>
          <TextInput
            placeholder="type a question, ctrl-c to stop"
            onSubmit={(q: string) => {
              if (q.trim()) dispatch({ type: "submit_query", query: q });
            }}
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
  const instance = render(
    <View bus={bus} dispatch={dispatch} bootstrap={bootstrap} />,
  );
  return () => instance.unmount();
}
