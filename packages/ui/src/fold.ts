/**
 * The generic agent fold: one agent's life on a view, folded from the bus
 * events every pool emits. Framework-free — the Ink view, the desktop shell's
 * own fold and the browser page all fold the same records — and it knows no
 * product: which spawns get a timeline, and what an agent's task is called,
 * are the application's decisions, handed in at `agent:spawn`.
 *
 * What it owns: the per-agent record ({@link AgentRuntime}), the `<think>`
 * boundary machine (a live think block advances until the marker, then closes
 * and seeds the content buffer with the tail), the timeline items — think,
 * tool call, tool result, report — with their summaries, retry state, and the
 * terminal transitions (`return`/`recovered` → done, `failed`, and the
 * stall-break `done` that precedes a forced recovery).
 *
 * @packageDocumentation
 * @category UI
 */

/** One cited source, extracted CONSUMER-side from a tool result (the Ability
 *  Protocol prescribes no result schema). Web tools populate url/title/snippet;
 *  image and icon arrive when an ability emits them; a corpus ability fills
 *  whatever subset applies. */
export interface SourceMeta {
  url?: string;
  title?: string;
  snippet?: string;
  image?: string;
  icon?: string;
  /** Display host, derived from url when present. */
  host?: string;
}

/** Per-agent chronological stream item — a renderer lays one component per
 *  kind. `live: true` on a think item means its body is currently streaming. */
export type TimelineItem =
  | { kind: 'think'; id: number; title: string; body: string; live: boolean; openedAt: number; closedAt: number | null }
  | { kind: 'tool_call'; id: number; tool: string; argsSummary: string }
  | {
      kind: 'tool_result';
      id: number;
      tool: string;
      /** The tool_call id this result pairs with, for a renderer that indents results under their call. */
      callId: number | null;
      byteLength: number;
      preview: string | null;
      hosts: string[];
      resultCount: number | null;
      /** Per-source citation metadata parsed from the tool's free-form result. */
      sources?: SourceMeta[];
    }
  | { kind: 'report'; id: number; body: string; tokenCount: number };

export interface AgentRuntime {
  id: number;
  /** "A0", "A1", … in spawn order within the roster. */
  label: string;
  phase: 'idle' | 'thinking' | 'content' | 'tool' | 'done' | 'failed';
  tokenCount: number;
  toolCallCount: number;
  /** Wall-clock spawn time (ms). */
  startedAt: number;
  /** Wall-clock completion time (ms), set when the agent reaches `done` or `failed`. */
  endedAt: number | null;
  /** The application's index for this agent's task; null for an agent that works no task of the plan (a settling pass, a probe). */
  taskIndex: number | null;
  taskDescription: string | null;
  /** A dependency hint for a chained task ("builds on Task 1"). */
  dependencyHint: string | null;
  /** Id of the currently-live think item in `timeline`, or null. */
  currentThinkId: number | null;
  /** Id of the most recent tool_call, paired with its tool_result when one lands. */
  pendingToolCallId: number | null;
  /** A parked tool call: the provider was rate-limited and the pool re-executes after the delay. */
  retry: { tool: string; retryAt: number; attempt: number } | null;
  /** Live post-`</think>` token buffer: the model writing its tool-call JSON, or a forced recovery's prose. */
  contentBuffer: string;
  /** True while the agent is being force-recovered: `agent:done` fired without a report and the pool
   *  streams a forced one; produce tokens go to `contentBuffer`, not a think block. */
  recovering: boolean;
  /** Set when the agent ended without a result: the terminal failure's reason. */
  failReason: string | null;
  /** Think blocks, tool rows, the report — or null for an agent tracked by its numbers only. */
  timeline: TimelineItem[] | null;
}

/** What a roster holds beside its agents: the counters that keep timeline ids and labels stable. */
export interface AgentRoster {
  agents: Map<number, AgentRuntime>;
  nextTimelineId: number;
  nextLabelIdx: number;
}

export const emptyRoster = (): AgentRoster => ({ agents: new Map(), nextTimelineId: 0, nextLabelIdx: 0 });

/** The bus events the fold reads, structurally — the agents package's own
 *  vocabulary, versioned beside it; every field the fold touches is guarded. */
export type AgentEvent =
  | { type: 'agent:spawn'; agentId: number; parentAgentId?: number; key?: string; after?: number[] }
  | { type: 'agent:produce'; agentId: number; text: string; tokenCount: number }
  | { type: 'agent:tool_call'; agentId: number; tool: string; args: string }
  | { type: 'agent:tool_retry'; agentId: number; tool: string; retryAfterMs: number; attempt: number }
  | { type: 'agent:tool_result'; agentId: number; tool: string; result: string }
  | { type: 'agent:return'; agentId: number; result: string }
  | { type: 'agent:recovered'; agentId: number; result: string }
  | { type: 'agent:failed'; agentId: number; reason: string }
  | { type: 'agent:done'; agentId: number };

/** What the application decides at a spawn — two facts, not one: whether the agent keeps a timeline, and which
 *  task of the plan it works (null: none — a settling pass keeps a timeline and works no task; a helper the view
 *  never shows keeps neither). */
export interface SpawnDecision {
  timeline: boolean;
  taskIndex: number | null;
  taskDescription?: string | null;
  dependencyHint?: string | null;
}

export interface FoldAgentsOptions {
  /** The application's decision at `agent:spawn`. Default: every agent is tracked by its numbers only, with no timeline and no task. */
  spawn?: (ev: Extract<AgentEvent, { type: 'agent:spawn' }>) => SpawnDecision;
  /** The tool whose call ends the turn. Its call is not a timeline row: the report streamed live and
   *  `agent:return` files it. */
  terminal?: string;
  /** The argument of the terminal tool whose text is the report, streamed as the model writes it.
   *  @default 'result' */
  terminalField?: string;
  /** The clock, for tests. */
  now?: () => number;
}

/** The argument a terminal tool's report is read from unless the application names another. */
export const DEFAULT_TERMINAL_FIELD = 'result';

/** Live report markdown from a raw Hermes tool-call buffer
 *  (`<tool_call>\n<function=TOOL>\n<parameter=FIELD>\n<markdown>\n</parameter>…`). Null until the open marker
 *  arrives, so a half-written call never flashes as prose. A forced recovery streams raw prose with no envelope —
 *  callers branch on `recovering` first.
 *
 *  Name the terminal `tool` and only ITS call is read: an argument name says nothing about which tool it belongs
 *  to, and an ordinary tool may well share one (`write_file(body)` beside `finish(body)`). Without a tool, any
 *  call carrying the argument is read. */
export function extractStreamingReport(buffer: string, terminal: { tool?: string; field?: string } = {}): string | null {
  const OPEN = `<parameter=${terminal.field ?? DEFAULT_TERMINAL_FIELD}>`;
  let from = 0;
  if (terminal.tool !== undefined) {
    // The call being written is the last envelope opened, and a call is known by its envelope — the `<function=`
    // that follows `<tool_call>` — never by marker-like text inside a body that is still being written.
    const lastCall = buffer.lastIndexOf('<tool_call>');
    if (lastCall === -1) return null;
    const fn = buffer.indexOf('<function=', lastCall);
    if (fn === -1 || !buffer.startsWith(`<function=${terminal.tool}>`, fn)) return null;
    from = fn;
  }
  const i = buffer.indexOf(OPEN, from);
  if (i === -1) return null;
  let body = buffer.slice(i + OPEN.length);
  const c = body.indexOf('</parameter>');
  if (c !== -1) body = body.slice(0, c);
  return body.replace(/^\n/, '');
}

const THINK_CLOSE = '</think>';

/** First meaningful line of a think-block body, cleaned up for a title. */
export function extractTitle(body: string): string {
  const text = body.replace(/^\s*\n/, '').replace(/\*\*/g, '').replace(/^#+\s*/, '').trim();
  if (!text) return 'Thinking…';
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 72 ? firstLine.slice(0, 72).trimEnd() + '…' : firstLine;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A one-line summary of a tool call's arguments: the query, pattern, url or filename it named. */
export function formatArgSummary(_tool: string, rawArgs: string): string {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawArgs); } catch { parsed = {}; }
  const q = typeof parsed.query === 'string' ? parsed.query
    : typeof parsed.pattern === 'string' ? parsed.pattern
    : typeof parsed.url === 'string' ? parsed.url
    : typeof parsed.filename === 'string' ? parsed.filename
    : '';
  return q ? `"${q.length > 48 ? q.slice(0, 48) + '…' : q}"` : '';
}

export interface ResultSummary {
  summary: string;
  hosts: string[];
  resultCount: number | null;
  preview: string | null;
  sources?: SourceMeta[];
}

/** A per-tool summary of a result, parsed from the stock abilities' result
 *  shapes (web search and fetch, corpus search, grep and read); anything else
 *  falls back to the URLs it carries, else its size. */
export function summarizeResult(tool: string, raw: string): ResultSummary {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (tool === 'web_search' && Array.isArray(parsed)) {
      const items = parsed as { url?: string; title?: string; snippet?: string; image?: string; icon?: string }[];
      const hosts = Array.from(new Set(items.map((i) => (i.url ? hostOf(i.url) : '')).filter(Boolean))).slice(0, 3);
      const sources: SourceMeta[] = items
        .filter((i) => i.url || i.title)
        .slice(0, 8)
        .map((i) => ({ url: i.url, title: i.title, snippet: i.snippet, image: i.image, icon: i.icon, host: i.url ? hostOf(i.url) : undefined }));
      return { summary: `${items.length} results`, hosts, resultCount: items.length, preview: items[0]?.title ?? null, sources: sources.length ? sources : undefined };
    }
    if (tool === 'search' && typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { hits?: unknown }).hits)) {
      const hits = (parsed as { hits: { file?: string; heading?: string }[] }).hits;
      const sources: SourceMeta[] = hits.slice(0, 8).map((h) => ({ title: h.heading || h.file, host: h.file })).filter((s) => s.title || s.host);
      return { summary: `${hits.length} results`, hosts: [], resultCount: hits.length, preview: hits[0]?.heading ?? hits[0]?.file ?? null, sources: sources.length ? sources : undefined };
    }
    if (tool === 'grep' && typeof parsed === 'object' && parsed !== null) {
      const r = parsed as { totalMatches?: number; matches?: { file?: string; line?: number; text?: string }[] };
      const matches = r.matches ?? [];
      const sources: SourceMeta[] = matches.slice(0, 8)
        .map((m) => ({ title: m.file, host: m.line != null ? `line ${m.line}` : undefined, snippet: m.text }))
        .filter((s) => s.title);
      return { summary: `${r.totalMatches ?? 0} matches`, hosts: [], resultCount: r.totalMatches ?? null, preview: matches[0]?.file ?? null, sources: sources.length ? sources : undefined };
    }
    if (tool === 'read_file' && typeof parsed === 'object' && parsed !== null) {
      const r = parsed as { file?: string; error?: string };
      if (r.error) return { summary: r.error, hosts: [], resultCount: null, preview: null };
      const sources: SourceMeta[] = r.file ? [{ title: r.file }] : [];
      return { summary: `${raw.length}b`, hosts: [], resultCount: null, preview: r.file ?? null, sources: sources.length ? sources : undefined };
    }
    if ((tool === 'fetch_page' || tool === 'web_fetch') && typeof parsed === 'object' && parsed !== null) {
      const r = parsed as { url?: string; title?: string; error?: string; excerpt?: string; image?: string; icon?: string };
      if (r.error) return { summary: r.error, hosts: [], resultCount: null, preview: null };
      const hosts = r.url ? [hostOf(r.url)] : [];
      const sources: SourceMeta[] | undefined = r.url || r.title
        ? [{ url: r.url, title: r.title, snippet: r.excerpt, image: r.image, icon: r.icon, host: r.url ? hostOf(r.url) : undefined }]
        : undefined;
      return { summary: `${raw.length}b`, hosts, resultCount: null, preview: r.title ?? null, sources };
    }
  } catch {
    /* fall through to the URL scan */
  }
  const urls = Array.from(raw.matchAll(/https?:\/\/[^\s\])>"]+/g)).map((m) => m[0]);
  if (urls.length > 0) {
    return { summary: `${urls.length} links`, hosts: Array.from(new Set(urls.map(hostOf))).slice(0, 3), resultCount: urls.length, preview: null };
  }
  return { summary: `${raw.length}b`, hosts: [], resultCount: null, preview: null };
}

// ── immutable helpers over the roster ──────────────────────────────

function replaceAgent(r: AgentRoster, id: number, patch: (a: AgentRuntime) => AgentRuntime): AgentRoster {
  const existing = r.agents.get(id);
  if (!existing) return r;
  const agents = new Map(r.agents);
  agents.set(id, patch(existing));
  return { ...r, agents };
}

function createAgent(r: AgentRoster, id: number, now: number, patch: Partial<AgentRuntime>): AgentRoster {
  if (r.agents.has(id)) return r;
  const base: AgentRuntime = {
    id, label: `A${r.nextLabelIdx}`, phase: 'idle', startedAt: now, endedAt: null, tokenCount: 0, toolCallCount: 0,
    taskIndex: null, taskDescription: null, dependencyHint: null, currentThinkId: null, pendingToolCallId: null,
    retry: null, contentBuffer: '', recovering: false, failReason: null, timeline: null,
    ...patch,
  };
  const agents = new Map(r.agents);
  agents.set(id, base);
  return { ...r, agents, nextLabelIdx: r.nextLabelIdx + 1 };
}

const pushTimeline = (a: AgentRuntime, item: TimelineItem): AgentRuntime => ({ ...a, timeline: [...(a.timeline ?? []), item] });
const updateTimeline = (a: AgentRuntime, id: number, update: (item: TimelineItem) => TimelineItem): AgentRuntime =>
  ({ ...a, timeline: (a.timeline ?? []).map((it) => (it.id === id ? update(it) : it)) });

/** Open a new live think block on this agent. */
function openThink(r: AgentRoster, agentId: number, now: number): AgentRoster {
  const id = r.nextTimelineId;
  const next = replaceAgent(r, agentId, (a) =>
    pushTimeline({ ...a, currentThinkId: id, phase: 'thinking' }, { kind: 'think', id, title: 'Thinking…', body: '', live: true, openedAt: now, closedAt: null }));
  return { ...next, nextTimelineId: r.nextTimelineId + 1 };
}

/** Close the agent's live think block with `finalBody`. */
function closeThink(r: AgentRoster, agentId: number, finalBody: string, now: number): AgentRoster {
  const agent = r.agents.get(agentId);
  if (!agent || agent.currentThinkId === null) return r;
  const thinkId = agent.currentThinkId;
  const title = extractTitle(finalBody);
  return replaceAgent(r, agentId, (a) =>
    updateTimeline({ ...a, currentThinkId: null, phase: 'content' }, thinkId, (it) =>
      it.kind === 'think' ? { ...it, body: finalBody, title, live: false, closedAt: now } : it));
}

/** Close any live think block, keeping whatever body it holds — the recovery and tool-call paths may reach here without a `</think>`. */
function closeLiveThink(r: AgentRoster, agentId: number, now: number): AgentRoster {
  const agent = r.agents.get(agentId);
  if (!agent || agent.currentThinkId === null) return r;
  const item = agent.timeline?.find((it) => it.id === agent.currentThinkId);
  return closeThink(r, agentId, item && item.kind === 'think' ? item.body : '', now);
}

/** Advance the live think block: append until `</think>`, then close on the marker and seed the content buffer with the tail. */
function advanceThink(r: AgentRoster, agentId: number, text: string, tokenCount: number, now: number): AgentRoster {
  const agent = r.agents.get(agentId);
  if (!agent || agent.currentThinkId === null) return r;
  const thinkId = agent.currentThinkId;
  const item = agent.timeline?.find((it) => it.id === thinkId);
  if (!item || item.kind !== 'think') return r;
  const combined = item.body + text;
  const markerIdx = combined.indexOf(THINK_CLOSE);
  if (markerIdx === -1) {
    return replaceAgent(r, agentId, (a) => updateTimeline({ ...a, tokenCount }, thinkId, (it) => (it.kind === 'think' ? { ...it, body: combined } : it)));
  }
  const finalBody = combined.slice(0, markerIdx);
  const tail = combined.slice(markerIdx + THINK_CLOSE.length);
  return replaceAgent(closeThink(r, agentId, finalBody, now), agentId, (a) => ({ ...a, tokenCount, contentBuffer: tail }));
}

/**
 * Fold one agent event into the roster. Returns the same roster when the event
 * changed nothing. An event for an unknown agent is dropped.
 */
export function foldAgents(r: AgentRoster, ev: AgentEvent, opts: FoldAgentsOptions = {}): AgentRoster {
  const now = (opts.now ?? Date.now)();
  switch (ev.type) {
    case 'agent:spawn': {
      const decision = opts.spawn?.(ev) ?? { timeline: false, taskIndex: null };
      const next = createAgent(r, ev.agentId, now, {
        phase: decision.timeline ? 'thinking' : 'idle',
        timeline: decision.timeline ? [] : null,
        taskIndex: decision.taskIndex,
        taskDescription: decision.taskDescription ?? null,
        dependencyHint: decision.dependencyHint ?? null,
      });
      return decision.timeline ? openThink(next, ev.agentId, now) : next;
    }

    case 'agent:produce': {
      const agent = r.agents.get(ev.agentId);
      if (!agent) return r;
      if (agent.timeline === null) return replaceAgent(r, ev.agentId, (a) => ({ ...a, tokenCount: ev.tokenCount }));
      // Content-phase tokens (post-</think>, pre-tool_call): the model writing its tool-call JSON — the
      // terminal tool's body lives inside it, so it streams into the buffer a renderer can read live.
      if (agent.phase === 'content' || agent.recovering) {
        return replaceAgent(r, ev.agentId, (a) => ({ ...a, tokenCount: ev.tokenCount, contentBuffer: a.contentBuffer + ev.text }));
      }
      let working = r;
      if (agent.phase !== 'thinking' || agent.currentThinkId === null) {
        if (agent.phase === 'tool' || agent.phase === 'idle') working = openThink(working, ev.agentId, now);
        else return replaceAgent(working, ev.agentId, (a) => ({ ...a, tokenCount: ev.tokenCount }));   // done or failed: count only
      }
      return advanceThink(working, ev.agentId, ev.text, ev.tokenCount, now);
    }

    case 'agent:tool_call': {
      const agent = r.agents.get(ev.agentId);
      if (!agent) return r;
      const working = closeLiveThink(r, ev.agentId, now);
      if (agent.timeline === null) {
        return replaceAgent(working, ev.agentId, (a) => ({ ...a, phase: 'tool', toolCallCount: a.toolCallCount + 1 }));
      }
      // The terminal tool fires at the stop token, but its report already streamed as content: no timeline row,
      // the buffer clears, and `agent:return` files the report next.
      const acting = working.agents.get(ev.agentId);
      // A named terminal is recognised by its name and nothing else. Only an application that names none falls
      // back to the shape of what streamed.
      const wasReporting = opts.terminal !== undefined
        ? ev.tool === opts.terminal
        : extractStreamingReport(acting?.contentBuffer ?? '', { field: opts.terminalField }) !== null;
      if (wasReporting) {
        return replaceAgent(working, ev.agentId, (a) => ({ ...a, phase: 'tool', toolCallCount: a.toolCallCount + 1, contentBuffer: '' }));
      }
      const id = working.nextTimelineId;
      const next = replaceAgent(working, ev.agentId, (a) =>
        pushTimeline({ ...a, phase: 'tool', toolCallCount: a.toolCallCount + 1, pendingToolCallId: id, contentBuffer: '' },
          { kind: 'tool_call', id, tool: ev.tool, argsSummary: formatArgSummary(ev.tool, ev.args) }));
      return { ...next, nextTimelineId: working.nextTimelineId + 1 };
    }

    case 'agent:tool_retry': {
      if (!r.agents.has(ev.agentId)) return r;
      return replaceAgent(r, ev.agentId, (a) => ({ ...a, retry: { tool: ev.tool, retryAt: now + ev.retryAfterMs, attempt: ev.attempt } }));
    }

    case 'agent:tool_result': {
      const agent = r.agents.get(ev.agentId);
      if (!agent) return r;
      if (agent.timeline === null) return replaceAgent(r, ev.agentId, (a) => ({ ...a, phase: 'idle', retry: null }));
      const summary = summarizeResult(ev.tool, ev.result);
      const id = r.nextTimelineId;
      const next = replaceAgent(r, ev.agentId, (a) =>
        pushTimeline({ ...a, phase: 'idle', pendingToolCallId: null, retry: null }, {
          kind: 'tool_result', id, tool: ev.tool, callId: agent.pendingToolCallId, byteLength: ev.result.length,
          preview: summary.preview, hosts: Array.from(new Set(summary.hosts)), resultCount: summary.resultCount, sources: summary.sources,
        }));
      return { ...next, nextTimelineId: r.nextTimelineId + 1 };
    }

    case 'agent:return':
    case 'agent:recovered': {
      const agent = r.agents.get(ev.agentId);
      if (!agent) return r;
      const working = closeLiveThink(r, ev.agentId, now);
      if (agent.timeline === null) {
        return replaceAgent(working, ev.agentId, (a) => ({ ...a, phase: 'done', endedAt: now, contentBuffer: '', recovering: false }));
      }
      const id = working.nextTimelineId;
      const next = replaceAgent(working, ev.agentId, (a) =>
        pushTimeline({ ...a, phase: 'done', endedAt: now, contentBuffer: '', recovering: false },
          { kind: 'report', id, body: ev.result, tokenCount: a.tokenCount }));
      return { ...next, nextTimelineId: working.nextTimelineId + 1 };
    }

    case 'agent:failed': {
      const agent = r.agents.get(ev.agentId);
      if (!agent || agent.phase === 'done' || agent.phase === 'failed') return r;
      const working = closeLiveThink(r, ev.agentId, now);
      return replaceAgent(working, ev.agentId, (a) => ({ ...a, phase: 'failed', endedAt: now, contentBuffer: '', recovering: false, failReason: ev.reason }));
    }

    case 'agent:done': {
      // Not `done` yet: in the stall-break path this precedes the forced recovery's produce stream and
      // `agent:recovered`. Close any live think, step back to idle, and route what follows into the buffer.
      const agent = r.agents.get(ev.agentId);
      if (!agent || agent.phase === 'done' || agent.phase === 'failed') return r;   // terminal either way
      const working = closeLiveThink(r, ev.agentId, now);
      return replaceAgent(working, ev.agentId, (a) => ({ ...a, phase: 'idle', contentBuffer: '', recovering: true }));
    }

    default:
      return r;
  }
}
