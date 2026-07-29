/**
 * The terminal view — a `render`-style binding: `(bus, dispatch, bootstrap) =>
 * dispose`. It subscribes to your events, folds them through `reduce`
 * (state.ts), and renders the standard `AppState`. It knows nothing about your
 * domain — swap it, or grow it, or keep it; the harness never changes.
 *
 * Austere on purpose (the browser/desktop view is the rich one): a header, the
 * LIVE agents as side-by-side columns, a KV gauge, an input line — and finished
 * agents + each answer committed to Ink's `<Static>`, which paints them to the
 * terminal's scrollback ONCE and never re-renders them. That's the load-bearing
 * detail: without it, a long run's growing tree overflows the viewport and Ink
 * clears the screen (wiping your history). Live in the dynamic frame, done in
 * Static.
 */
import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { EventBus } from "@lloyal-labs/binding";
import {
  initialState,
  reduce,
  formatSize,
  cleanNarration,
  toolArgSummary,
  resultMeta,
  wikipediaSources,
  isResearchAgent,
} from "../../harness/state.js";
import type {
  AgentView,
  AppState,
  Phase,
  ToolStep,
  WikiSource,
} from "../../harness/state.js";
import type { Command, WorkflowEvent } from "../../harness/protocol.js";

const seed = (bootstrap: WorkflowEvent[]): AppState =>
  bootstrap.reduce(reduce, initialState);

const glyph = (s: AgentView["status"]): string =>
  s === "active" ? "●" : s === "tool" ? "◍" : s === "done" ? "✓" : "✗";

const statusColor = (s: AgentView["status"]): string =>
  s === "active" ? "yellow" : s === "tool" ? "cyan" : s === "done" ? "green" : "red";

/** Hostname of a URL, `www.` stripped — for the sources footer. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

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

/** A LIVE agent, as a fixed-width column: header · recent tool chips · a short
 *  narration preview (the last line of the model's prose, XML stripped). The
 *  bounded shape (last 4 chips + 1 line) keeps the dynamic frame small. */
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

/** A FINISHED research agent, collapsed to a one-line summary in Static — the
 *  live detail scrolled by; the record is a tidy line. */
function FinishedAgentRow({ a }: { a: AgentView }): React.ReactElement {
  const reads = a.tools.filter((t) => t.tool === "wikipedia_fetch" && t.result !== null).length;
  return (
    <Text>
      <Text color={statusColor(a.status)}>{glyph(a.status)}</Text>
      {` agent ${a.id}`}
      <Text dimColor>
        {` · ${a.toolCalls} tool${a.toolCalls === 1 ? "" : "s"}`}
        {reads ? ` · ${reads} article${reads === 1 ? "" : "s"}` : ""}
      </Text>
    </Text>
  );
}

/** A committed answer in Static: the clean report text + its grounded sources. */
function AnswerBlock({ text, sources }: { text: string; sources: WikiSource[] }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan">{text}</Text>
      {sources.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Sources</Text>
          {sources.map((s, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {`  ${i + 1}. ${s.title}${s.url ? ` · ${hostOf(s.url)}` : ""}`}
            </Text>
          ))}
        </Box>
      )}
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

/** One committed line of scrollback — a finished agent or an answer. */
type Scrollback =
  | { kind: "agent"; agent: AgentView }
  | { kind: "answer"; text: string; sources: WikiSource[] };

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

  // Move finished work into Static so it's painted to scrollback ONCE and never
  // re-rendered: each research agent when it terminates, and each answer on the
  // working→answered transition. The dynamic frame below then holds only the
  // live agents + input, so it can't grow past the viewport and trigger Ink's
  // clear-on-overflow.
  const [scrollback, setScrollback] = useState<Scrollback[]>([]);
  const committed = useRef<Set<number>>(new Set());
  const prevPhase = useRef<Phase>("booting");
  useEffect(() => {
    const add: Scrollback[] = [];
    for (const a of state.agents.values()) {
      if (
        isResearchAgent(a) &&
        (a.status === "done" || a.status === "failed") &&
        !committed.current.has(a.id)
      ) {
        committed.current.add(a.id);
        add.push({ kind: "agent", agent: a });
      }
    }
    if (state.phase === "answered" && prevPhase.current !== "answered" && state.answer) {
      add.push({
        kind: "answer",
        text: state.answer,
        sources: wikipediaSources(state.agents.values()),
      });
    }
    prevPhase.current = state.phase;
    if (add.length) setScrollback((s) => [...s, ...add]);
  }, [state]);

  const working = state.phase === "working";
  // Only the still-running agents stay in the dynamic frame; finished ones are
  // in Static. The synth (tool-less) streams here as a column until it's done.
  const live = [...state.agents.values()].filter(
    (a) => a.status === "active" || a.status === "tool",
  );
  const cols = process.stdout.columns ?? 80;
  const colWidth = Math.max(30, Math.min(56, Math.floor((cols - 2) / Math.max(1, live.length)) - 2));

  return (
    <>
      <Static items={scrollback}>
        {(item, i) =>
          item.kind === "agent" ? (
            <FinishedAgentRow key={`sb-${i}`} a={item.agent} />
          ) : (
            <AnswerBlock key={`sb-${i}`} text={item.text} sources={item.sources} />
          )
        }
      </Static>

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

        {live.length > 0 && (
          <Box flexDirection="column">
            <Box flexWrap="wrap">
              {live.map((a) => (
                <AgentColumn key={a.id} a={a} width={colWidth} />
              ))}
            </Box>
            <Gauge used={state.kv.used} total={state.kv.total} />
          </Box>
        )}

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
    </>
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
