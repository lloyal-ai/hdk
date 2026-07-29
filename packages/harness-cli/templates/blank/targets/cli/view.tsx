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
import {
  initialState,
  reduce,
  formatSize,
  cleanNarration,
  toolArgSummary,
  resultMeta,
} from "../../harness/state.js";
import type { AgentView, AppState, ToolStep } from "../../harness/state.js";
import type { Command, WorkflowEvent } from "../../harness/protocol.js";

const seed = (bootstrap: WorkflowEvent[]): AppState =>
  bootstrap.reduce(reduce, initialState);

const glyph = (s: AgentView["status"]): string =>
  s === "active" ? "●" : s === "tool" ? "◍" : s === "done" ? "✓" : "✗";

const statusColor = (s: AgentView["status"]): string =>
  s === "active" ? "yellow" : s === "tool" ? "cyan" : s === "done" ? "green" : "red";

/** One tool invocation as an atomic chip: `⚒ tool · args → result-meta`. */
function ToolChip({ step }: { step: ToolStep }): React.ReactElement {
  const args = toolArgSummary(step.args);
  return (
    <Text wrap="truncate-end">
      <Text color="magenta">⚒ {step.tool}</Text>
      {args ? <Text dimColor>{`  ${args}`}</Text> : null}
      <Text color={step.result === null ? "gray" : "green"}>{`  → ${resultMeta(step.result)}`}</Text>
    </Text>
  );
}

/** One agent, as a fixed-width column: header · recent tool chips · a short
 *  narration preview (the last line of the model's prose, XML stripped). */
function AgentColumn({ a, width }: { a: AgentView; width: number }): React.ReactElement {
  const preview = cleanNarration(a.body).split("\n").filter(Boolean).slice(-1)[0] ?? "";
  return (
    <Box flexDirection="column" width={width} marginRight={2}>
      <Text wrap="truncate-end">
        <Text color={statusColor(a.status)}>{glyph(a.status)}</Text>
        {` agent ${a.id}`}
        <Text dimColor>{` · ${a.tokens} tok`}</Text>
      </Text>
      {a.tools.slice(-4).map((t, i) => (
        <ToolChip key={i} step={t} />
      ))}
      {preview ? (
        <Text dimColor wrap="truncate-end">
          {preview}
        </Text>
      ) : null}
    </Box>
  );
}

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
  // Lay parallel agents side by side — one column each, sized to the terminal
  // (falls back to 80 cols when stdout isn't a TTY, e.g. the desktop fork).
  const cols = process.stdout.columns ?? 80;
  const colWidth = Math.max(30, Math.min(56, Math.floor((cols - 2) / Math.max(1, agents.length)) - 2));

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{"__NAME__"}</Text>
        {/* Measured facts from the `ready` event — the model's real size + the
            apps actually enabled, never a hardcoded string. */}
        {state.boot ? (
          <>
            <Text color="gray">{`Model      ${state.boot.model.id} · ${formatSize(state.boot.model.sizeBytes)} · resident`}</Text>
            <Text color="gray">Inference  local · no provider</Text>
            <Text color="gray">{`Apps       ${state.boot.apps.length ? state.boot.apps.join(", ") : "none installed"}`}</Text>
            <Text color="gray">{`Surface    ${state.boot.surface}`}</Text>
          </>
        ) : (
          <Text color="gray">booting…</Text>
        )}
      </Box>

      {agents.length > 0 && (
        <Box flexDirection="column">
          <Box flexWrap="wrap">
            {agents.map((a) => (
              <AgentColumn key={a.id} a={a} width={colWidth} />
            ))}
          </Box>
          <Gauge used={state.kv.used} total={state.kv.total} />
        </Box>
      )}

      {state.answer && <Text color="cyan">{state.answer}</Text>}
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
