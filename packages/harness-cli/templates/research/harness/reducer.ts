/**
 * Pure event → AppState reducer.
 *
 * Owns: phase transitions, per-agent state machine (<think> boundary
 * detection), timeline item accrual (think / tool_call / tool_result /
 * report), synth buffer.
 *
 * Emits no side effects. Feed it a trace of StepEvent + AgentEvent; it
 * returns the view-ready state.
 */

import type { AppState, AgentRuntime, TimelineItem, SourceMeta } from './state-core.js';
import { initialState } from './state-core.js';
import type { WorkflowEvent } from './events.js';
import type { Config } from './config-types.js';
import { shortPath } from './short-path.js';

/** Seed/refresh `participation` from current config. The reducer holds NO
 *  per-app knowledge: apps default to included via the `!== false`
 *  convention (any app absent from the map renders as included), so there's
 *  nothing to seed here on a plain config load. The included-by-default set
 *  is the registry-enabled apps surfaced via `apps:state`; per-app intent is
 *  driven explicitly through `participation:toggled` (chip toggle) and
 *  `set_app_config` (configuring → main.ts sets the bit + re-emits state).
 *  Returns `prev` unchanged — kept as a function so config events have a
 *  single, named place to hook future participation policy. */
function seedParticipation(
  prev: Record<string, boolean>,
  _cfg: Config,
): Record<string, boolean> {
  return prev;
}

const THINK_CLOSE = '</think>';

/** First meaningful line of a think-block body, cleaned up for a title. */
function extractTitle(body: string): string {
  const text = body
    .replace(/^\s*\n/, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/, '')
    .trim();
  if (!text) return 'Thinking…';
  const firstLine = text.split('\n')[0].trim();
  const clipped = firstLine.length > 72 ? firstLine.slice(0, 72).trimEnd() + '…' : firstLine;
  return clipped;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Best-effort argsSummary for tool_call rendering. One-liners per tool. */
function formatArgSummary(tool: string, rawArgs: string): string {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawArgs); } catch { parsed = {}; }
  const q = typeof parsed.query === 'string' ? parsed.query
    : typeof parsed.pattern === 'string' ? parsed.pattern
    : typeof parsed.url === 'string' ? parsed.url
    : typeof parsed.filename === 'string' ? parsed.filename
    : '';
  return q ? `"${q.length > 48 ? q.slice(0, 48) + '…' : q}"` : '';
}

/** Best-effort per-tool summary used by the column's ToolResult line. The
 *  `sources` field carries per-page citation metadata for the Sources ledger —
 *  extracted consumer-side from the tool's free-form result (the App Protocol
 *  prescribes no result schema). web_search/fetch_page already return
 *  url+title+snippet; image/icon (og:image + favicon) populate once the web app
 *  ≥1.2.0 emits them. */
function summarizeResult(tool: string, raw: string): {
  summary: string;
  hosts: string[];
  resultCount: number | null;
  preview: string | null;
  sources?: SourceMeta[];
} {
  // Try JSON parse first — structured tools (web_search, search, grep, plan).
  try {
    const parsed: unknown = JSON.parse(raw);
    if (tool === 'web_search' && Array.isArray(parsed)) {
      const items = parsed as {
        url?: string;
        title?: string;
        snippet?: string;
        image?: string;
        icon?: string;
      }[];
      const hosts = Array.from(
        new Set(items.map((i) => (i.url ? hostOf(i.url) : '')).filter(Boolean)),
      ).slice(0, 3);
      // Per-page citations (url+title+snippet are already returned; image/icon
      // arrive with web ≥1.2.0). Cap to keep the envelope small.
      const sources: SourceMeta[] = items
        .filter((i) => i.url || i.title)
        .slice(0, 8)
        .map((i) => ({
          url: i.url,
          title: i.title,
          snippet: i.snippet,
          image: i.image,
          icon: i.icon,
          host: i.url ? hostOf(i.url) : undefined,
        }));
      return {
        summary: `${items.length} results`,
        hosts,
        resultCount: items.length,
        preview: items[0]?.title ?? null,
        sources: sources.length ? sources : undefined,
      };
    }
    // Corpus semantic search → { hits: [{ file, heading, score }], … }. Each hit
    // is a local source (a file/section); emit per-hit metadata into `sources`
    // so the ledger surfaces corpus sources exactly like web pages. The ledger
    // is App-Protocol-agnostic — it keys off `sources[]`, not the app/tool name.
    if (
      tool === 'search' &&
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { hits?: unknown }).hits)
    ) {
      const hits = (parsed as { hits: { file?: string; heading?: string }[] }).hits;
      const sources: SourceMeta[] = hits
        .slice(0, 8)
        .map((h) => ({ title: h.heading || h.file, host: h.file }))
        .filter((s) => s.title || s.host);
      return {
        summary: `${hits.length} results`,
        hosts: [],
        resultCount: hits.length,
        preview: hits[0]?.heading ?? hits[0]?.file ?? null,
        sources: sources.length ? sources : undefined,
      };
    }
    // Corpus grep → { totalMatches, matches: [{ file, line, text }] }. One local
    // source per matching file, the matched line as the snippet.
    if (tool === 'grep' && typeof parsed === 'object' && parsed !== null) {
      const r = parsed as {
        totalMatches?: number;
        matches?: { file?: string; line?: number; text?: string }[];
      };
      const matches = r.matches ?? [];
      const sources: SourceMeta[] = matches
        .slice(0, 8)
        .map((m) => ({
          title: m.file,
          host: m.line != null ? `line ${m.line}` : undefined,
          snippet: m.text,
        }))
        .filter((s) => s.title);
      return {
        summary: `${r.totalMatches ?? 0} matches`,
        hosts: [],
        resultCount: r.totalMatches ?? null,
        preview: matches[0]?.file ?? null,
        sources: sources.length ? sources : undefined,
      };
    }
    // Corpus read_file → { file, content, lines } (or { file, note }). The agent
    // opened this file: one local source, marked via the fetch-tool name so the
    // ledger tiers it as "featured" (read closely) rather than merely surveyed.
    if (tool === 'read_file' && typeof parsed === 'object' && parsed !== null) {
      const r = parsed as { file?: string; error?: string };
      if (r.error) return { summary: r.error, hosts: [], resultCount: null, preview: null };
      const sources: SourceMeta[] = r.file ? [{ title: r.file }] : [];
      return {
        summary: `${raw.length}b`,
        hosts: [],
        resultCount: null,
        preview: r.file ?? null,
        sources: sources.length ? sources : undefined,
      };
    }
    if (
      (tool === 'fetch_page' || tool === 'web_fetch') &&
      typeof parsed === 'object' &&
      parsed !== null
    ) {
      const r = parsed as {
        url?: string;
        title?: string;
        error?: string;
        excerpt?: string;
        image?: string;
        icon?: string;
      };
      if (r.error) return { summary: r.error, hosts: [], resultCount: null, preview: null };
      const hosts = r.url ? [hostOf(r.url)] : [];
      // A fetched page is one rich citation: title + excerpt as the snippet,
      // plus og:image + favicon once the web app emits them (web ≥1.2.0).
      const sources: SourceMeta[] | undefined =
        r.url || r.title
          ? [
              {
                url: r.url,
                title: r.title,
                snippet: r.excerpt,
                image: r.image,
                icon: r.icon,
                host: r.url ? hostOf(r.url) : undefined,
              },
            ]
          : undefined;
      return {
        summary: `${raw.length}b`,
        hosts,
        resultCount: null,
        preview: r.title ?? null,
        sources,
      };
    }
  } catch {
    /* fall through to URL-scan fallback */
  }

  // Fallback: scrape hosts from raw URLs in the result payload.
  const urls = Array.from(raw.matchAll(/https?:\/\/[^\s\])>"]+/g)).map((m) => m[0]);
  if (urls.length > 0) {
    const hosts = Array.from(new Set(urls.map(hostOf))).slice(0, 3);
    return {
      summary: `${urls.length} links`,
      hosts,
      resultCount: urls.length,
      preview: null,
    };
  }

  return { summary: `${raw.length}b`, hosts: [], resultCount: null, preview: null };
}

// ── Immutable-update helpers ────────────────────────────────────

function replaceAgent(
  state: AppState,
  id: number,
  patch: (a: AgentRuntime) => AgentRuntime,
): AppState {
  const existing = state.agents.get(id);
  if (!existing) return state;
  const agents = new Map(state.agents);
  agents.set(id, patch(existing));
  return { ...state, agents };
}

function createAgent(state: AppState, id: number, patch: Partial<AgentRuntime> = {}): AppState {
  if (state.agents.has(id)) return state;
  const base: AgentRuntime = {
    id,
    label: `A${state.nextLabelIdx}`,
    phase: 'idle',
    startedAt: Date.now(),
    endedAt: null,
    tokenCount: 0,
    toolCallCount: 0,
    taskIndex: null,
    taskDescription: null,
    dependencyHint: null,
    currentThinkId: null,
    pendingToolCallId: null,
    retry: null,
    contentBuffer: '',
    recovering: false,
    failReason: null,
    timeline: [],
    ...patch,
  };
  const agents = new Map(state.agents);
  agents.set(id, base);
  return { ...state, agents, nextLabelIdx: state.nextLabelIdx + 1 };
}

function pushTimeline(agent: AgentRuntime, item: TimelineItem): AgentRuntime {
  return { ...agent, timeline: [...agent.timeline, item] };
}

function updateTimeline(
  agent: AgentRuntime,
  id: number,
  update: (item: TimelineItem) => TimelineItem,
): AgentRuntime {
  return {
    ...agent,
    timeline: agent.timeline.map((it) => (it.id === id ? update(it) : it)),
  };
}

/** Open a new live think block on this agent. */
function openThink(state: AppState, agentId: number): AppState {
  const id = state.nextTimelineId;
  const next = replaceAgent(state, agentId, (a) =>
    pushTimeline({ ...a, currentThinkId: id, phase: 'thinking' }, {
      kind: 'think',
      id,
      title: 'Thinking…',
      body: '',
      live: true,
      openedAt: Date.now(),
      closedAt: null,
    }),
  );
  return { ...next, nextTimelineId: state.nextTimelineId + 1 };
}

/** Close the agent's currently-live think block with finalBody. */
function closeThink(state: AppState, agentId: number, finalBody: string): AppState {
  const agent = state.agents.get(agentId);
  if (!agent || agent.currentThinkId === null) return state;
  const thinkId = agent.currentThinkId;
  const title = extractTitle(finalBody);
  return replaceAgent(state, agentId, (a) =>
    updateTimeline({ ...a, currentThinkId: null, phase: 'content' }, thinkId, (it) =>
      it.kind === 'think'
        ? { ...it, body: finalBody, title, live: false, closedAt: Date.now() }
        : it,
    ),
  );
}

// ── reducer entry ────────────────────────────────────────────────

export function reduce(state: AppState, ev: WorkflowEvent): AppState {
  switch (ev.type) {
    case 'query':
      // Preserve session-level fields across queries. Notably `mode` — a
      // `query` event fires at the start of every `runPlanner` call
      // (including re-plans on T toggle), and wiping mode would make the
      // PlanReview picker snap back to the default every time.
      return {
        ...initialState,
        config: state.config,
        configOrigin: state.configOrigin,
        uiPhase: state.uiPhase,
        mode: state.mode,
        nextToastId: state.nextToastId,
        toast: state.toast,
        scrollback: state.scrollback,
        participation: state.participation,
        apps: state.apps,
        query: ev.query,
        warm: ev.warm,
        phase: 'plan',
        startedAt: Date.now(),
      };

    case 'plan':
      return {
        ...state,
        uiPhase: ev.intent === 'clarify' ? 'clarifying' : state.uiPhase,
        phase: ev.intent === 'research' ? 'plan' : 'done',
        plan: {
          intent: ev.intent,
          tasks: ev.tasks,
          clarifyQuestions: ev.clarifyQuestions,
          tokenCount: ev.tokenCount,
          timeMs: ev.timeMs,
        },
        clarifyContext: ev.intent === 'clarify'
          ? { originalQuery: state.query, questions: ev.clarifyQuestions }
          : null,
      };

    case 'plan:task_updated': {
      if (!state.plan) return state;
      if (ev.index < 0 || ev.index >= state.plan.tasks.length) return state;
      const tasks = state.plan.tasks.map((t, i) =>
        i === ev.index ? { ...t, description: ev.description } : t,
      );
      return { ...state, plan: { ...state.plan, tasks } };
    }

    case 'plan:task_added': {
      if (!state.plan) return state;
      // afterIndex: -1 prepends; otherwise insert at afterIndex + 1.
      const insertAt = Math.max(0, Math.min(state.plan.tasks.length, ev.afterIndex + 1));
      const tasks = [
        ...state.plan.tasks.slice(0, insertAt),
        { description: '' },
        ...state.plan.tasks.slice(insertAt),
      ];
      return { ...state, plan: { ...state.plan, tasks } };
    }

    case 'plan:task_deleted': {
      if (!state.plan) return state;
      // Don't allow deleting the only task — keeps the plan-review valid.
      if (state.plan.tasks.length <= 1) return state;
      if (ev.index < 0 || ev.index >= state.plan.tasks.length) return state;
      const tasks = state.plan.tasks.filter((_, i) => i !== ev.index);
      return { ...state, plan: { ...state.plan, tasks } };
    }

    case 'plan:task_moved': {
      if (!state.plan) return state;
      const n = state.plan.tasks.length;
      if (ev.from === ev.to) return state;
      if (ev.from < 0 || ev.from >= n) return state;
      if (ev.to < 0 || ev.to >= n) return state;
      const tasks = [...state.plan.tasks];
      const [moved] = tasks.splice(ev.from, 1);
      tasks.splice(ev.to, 0, moved);
      return { ...state, plan: { ...state.plan, tasks } };
    }

    case 'research:start':
      // Resume the pipeline timer — it was paused on ui:plan_review while
      // the user reviewed the plan. Accumulator holds the planning-phase
      // time; now we add research/synth on top.
      return {
        ...state,
        uiPhase: 'research',
        phase: 'research',
        mode: ev.mode === 'flat' ? 'flat' : 'deep',
        // Authoritative fork count — the harness derives it from plan.tasks.length
        // BEFORE the pool spawns. Stored so "Forked N agents" is right even when
        // the renderer's plan.tasks is empty/late (the old `?? plan.tasks.length`
        // path rendered "Forked 0" while agents really forked).
        researchAgentCount: ev.agentCount,
        pipelineResumedAt: Date.now(),
      };

    case 'research:done':
      return { ...state, phase: 'synth' };

    case 'fanout:tasks':
      return state;

    case 'spine:task':
      return {
        ...state,
        pendingTaskIndex: ev.taskIndex,
        pendingTaskDescription: ev.description,
      };

    case 'spine:source':
    case 'spine:task:done':
      return state;

    case 'synthesize:start':
      return {
        ...state,
        phase: 'synth',
        synth: { open: true, buffer: '', done: false, stats: null },
      };

    case 'synthesize:done': {
      const body = state.synth.buffer.trim();
      const scrollback = body
        ? [
            ...state.scrollback,
            {
              key: `synth-${state.scrollback.length}-${Date.now()}`,
              kind: 'synth' as const,
              body,
            },
          ]
        : state.scrollback;
      return {
        ...state,
        scrollback,
        synth: {
          ...state.synth,
          open: false,
          done: true,
          stats: {
            tokens: ev.tokenCount,
            toolCalls: ev.toolCallCount,
            ppl: ev.ppl,
            timeMs: ev.timeMs,
          },
        },
      };
    }

    case 'answer':
      return { ...state, answer: ev.text };

    case 'stats':
      return {
        ...state,
        timings: ev.timings,
        pressure: {
          pct: ev.ctxPct,
          cellsUsed: ev.ctxPos,
          nCtx: ev.ctxTotal,
        },
      };

    case 'complete': {
      // Pipeline finished — bank the last active slice into the accumulator
      // and pause. The footer reads this frozen value until the next query
      // submit resets it.
      const accrued = state.pipelineResumedAt
        ? state.pipelineElapsedMs + (Date.now() - state.pipelineResumedAt)
        : state.pipelineElapsedMs;
      return {
        ...state,
        phase: 'done',
        uiPhase: 'done',
        pipelineElapsedMs: accrued,
        pipelineResumedAt: null,
      };
    }

    // ── UI + config events ───────────────────────────────────

    case 'config:loaded':
      // Just seed config — don't transition uiPhase. Boot flow is:
      //   boot → (download:start? → downloading) → weights:start → loading
      //   → ui:composer → composer
      // If we auto-flipped to 'composer' here, the composer would flash
      // briefly before the first boot-phase event arrived.
      // Also seed participation: web is always enabled (keyless fallback);
      // corpus is enabled iff a path is set. Both default to included.
      return {
        ...state,
        config: ev.config,
        configOrigin: ev.origin,
        participation: seedParticipation(state.participation, ev.config),
      };

    case 'config:updated': {
      const toastId = state.nextToastId + 1;
      const message = ev.skipped.length > 0
        ? `saved → ${shortPath(ev.savedTo)} (skipped: ${ev.skipped.join(', ')} — env active)`
        : ev.gitignored
          ? `saved → ${shortPath(ev.savedTo)} (added to .gitignore)`
          : `saved → ${shortPath(ev.savedTo)}`;
      // Reconfigure = strong signal of intent to use. Auto-include the
      // newly-(re)configured apps; drop participation entries for apps
      // whose config was just cleared.
      return {
        ...state,
        config: ev.config,
        configOrigin: ev.origin,
        participation: seedParticipation(state.participation, ev.config),
        toast: {
          id: toastId,
          message,
          tone: ev.skipped.length > 0 ? 'warn' : 'success',
        },
        nextToastId: toastId,
      };
    }

    case 'participation:toggled': {
      const current = state.participation[ev.name] ?? true;
      const next = !current;
      // Clear the "All sources excluded" error toast on any include — toggling
      // a source back on is the natural resolution. Drop on exclude too: the
      // toast was a submit-time complaint about the previous filter, so any
      // change to the filter invalidates it.
      return {
        ...state,
        participation: { ...state.participation, [ev.name]: next },
        toast: null,
      };
    }

    case 'apps:state':
      // Whole-replace the installed-AgentApps snapshot. Display-only — drives
      // the Settings drawer. Emitted on boot completion + every registry
      // enable/disable/config change.
      return { ...state, apps: ev.apps };

    case 'preflight:start': {
      // Pre-flight recon runs BEFORE the planner, so it's the first event of a
      // multi-app query. Reset to a clean run (like the `query` event does) and
      // enter the discovering phase; the recon agent's stream renders live via
      // the same Column machinery the research view uses. The planner's later
      // `query` event resets again before research, so recon agents are
      // transient — they vanish at the discovering → planning transition.
      const freshSubmission =
        state.uiPhase === 'composer' ||
        state.uiPhase === 'done' ||
        state.uiPhase === 'boot';
      return {
        ...initialState,
        config: state.config,
        configOrigin: state.configOrigin,
        mode: state.mode,
        nextToastId: state.nextToastId,
        toast: state.toast,
        scrollback: state.scrollback,
        corpusStatus: state.corpusStatus,
        participation: state.participation,
        apps: state.apps,
        query: ev.query,
        uiPhase: 'discovering',
        phase: 'recon',
        startedAt: Date.now(),
        pipelineElapsedMs: freshSubmission ? 0 : state.pipelineElapsedMs,
        pipelineResumedAt: Date.now(),
      };
    }

    case 'preflight:done':
      // Bracket-only — plan:start flips uiPhase to 'planning' next. The probe
      // detail lives in the recon agent's live stream, not here.
      return state;

    case 'plan:start': {
      // Fresh submission (from composer / done) → reset the pipeline timer
      // to zero. Re-plan from plan_review → keep the accumulator so the
      // displayed elapsed continues past the dwell.
      const freshSubmission =
        state.uiPhase === 'composer' ||
        state.uiPhase === 'done' ||
        state.uiPhase === 'boot';
      const base = freshSubmission
        ? { pipelineElapsedMs: 0, startedAt: Date.now() }
        : {};
      return {
        ...state,
        ...base,
        uiPhase: 'planning',
        phase: 'plan',
        plan: null,
        query: ev.query,
        mode: ev.mode === 'flat' ? 'flat' : 'deep',
        pipelineResumedAt: Date.now(),
      };
    }

    case 'ui:composer': {
      // Cancelled / finished — pause the timer if it was running. Preserve
      // the accumulator so the composer can show "last run took Xs" if we
      // ever want it.
      const accrued = state.pipelineResumedAt
        ? state.pipelineElapsedMs + (Date.now() - state.pipelineResumedAt)
        : state.pipelineElapsedMs;
      return {
        ...state,
        uiPhase: 'composer',
        composerPrefill: ev.prefill ?? '',
        clarifyContext: null,
        pipelineElapsedMs: accrued,
        pipelineResumedAt: null,
      };
    }

    case 'ui:plan_review': {
      // Pause the pipeline timer — user is dwelling on the plan, not the
      // machine doing work. Bank the running slice, clear the resume
      // timestamp. research:start / next plan:start will resume it.
      const accrued = state.pipelineResumedAt
        ? state.pipelineElapsedMs + (Date.now() - state.pipelineResumedAt)
        : state.pipelineElapsedMs;
      return {
        ...state,
        uiPhase: 'plan_review',
        pipelineElapsedMs: accrued,
        pipelineResumedAt: null,
      };
    }

    case 'ui:error': {
      const toastId = state.nextToastId + 1;
      return {
        ...state,
        uiPhase: 'composer',
        toast: { id: toastId, message: ev.message, tone: 'error' },
        nextToastId: toastId,
      };
    }

    // ── Boot phases ────────────────────────────────────────────

    case 'backendpack:offer':
      return {
        ...state,
        uiPhase: 'backend_pack_offer',
        backendPackOffer: {
          gpuName: ev.gpuName,
          sizeBytes: ev.sizeBytes,
          needsRuntime: ev.needsRuntime,
          runtimeSizeBytes: ev.runtimeSizeBytes,
          reasons: ev.reasons,
        },
      };

    case 'download:plan':
      // Plan is the ONLY event that grows state.downloads. Replaces the
      // array entirely with one entry per planned download. start /
      // progress / complete only mutate existing entries — they never
      // append. This makes duplicate-by-id structurally impossible.
      return {
        ...state,
        uiPhase: 'downloading',
        backendPackOffer: null,
        downloads: ev.entries.map((e) => ({
          id: e.id,
          label: e.label,
          got: 0,
          total: e.sizeBytes,
          done: false,
          started: false,
        })),
      };

    case 'download:start':
      // Mark the planned entry started. If no plan precedes (legacy /
      // unexpected path), drop the event rather than risk a duplicate
      // entry. uiPhase still flips to 'downloading' so the spinner
      // renders.
      return {
        ...state,
        uiPhase: 'downloading',
        downloads: state.downloads.map((d) =>
          d.id === ev.id ? { ...d, started: true } : d,
        ),
      };

    case 'download:progress':
      return {
        ...state,
        downloads: state.downloads.map((d) =>
          d.id === ev.id
            ? { ...d, started: true, got: ev.got, total: ev.total, url: ev.url ?? d.url }
            : d,
        ),
      };

    case 'download:complete':
      return {
        ...state,
        downloads: state.downloads.map((d) =>
          d.id === ev.id ? { ...d, got: d.total || d.got, done: true } : d,
        ),
      };

    case 'weights:start':
      // Also exits 'backend_pack_offer' on the decline path (no download
      // plan fires — boot proceeds straight to the load phase).
      return { ...state, uiPhase: 'loading', loadingLabel: ev.label, backendPackOffer: null };

    case 'weights:label':
      return { ...state, loadingLabel: ev.label };

    case 'weights:done':
      return { ...state, loadingLabel: null };

    case 'corpus:indexed':
      return {
        ...state,
        corpusStatus: { fileCount: ev.fileCount, chunkCount: ev.chunkCount },
      };

    case 'boot:error':
      return {
        ...state,
        uiPhase: 'boot_error',
        bootError: { kind: ev.kind, message: ev.message },
      };

    // ── Agent events ───────────────────────────────────────────

    case 'agent:spawn': {
      // Pre-flight recon agent: stream it through the same timeline machinery
      // as research (taskIndex 0 so the produce/tool handlers engage), but
      // track it in reconAgentIds so the research column never picks it up and
      // agent:return never freezes it into research scrollback.
      if (state.phase === 'recon') {
        const next = createAgent(state, ev.agentId, {
          phase: 'thinking',
          taskIndex: 0,
          taskDescription: 'Probing sources',
        });
        return openThink(
          { ...next, reconAgentIds: [...next.reconAgentIds, ev.agentId] },
          ev.agentId,
        );
      }

      // Non-research phase: track the agent but don't open a timeline.
      if (state.phase !== 'research') {
        return createAgent(state, ev.agentId, { phase: 'idle', taskIndex: null });
      }

      // Research phase: bind taskIndex + description, open the first think block.
      let taskIndex: number;
      let description: string | null;
      let nextPendingIdx: number | null = state.pendingTaskIndex;
      let nextPendingDesc: string | null = state.pendingTaskDescription;
      if (state.mode === 'deep') {
        taskIndex = nextPendingIdx ?? state.researchSpawnCount;
        description = nextPendingDesc
          ?? state.plan?.tasks[taskIndex]?.description
          ?? null;
        nextPendingIdx = null;
        nextPendingDesc = null;
      } else {
        taskIndex = state.researchSpawnCount;
        description = state.plan?.tasks[taskIndex]?.description ?? null;
      }

      const dependencyHint =
        state.mode === 'deep' && taskIndex > 0
          ? `builds on Task ${taskIndex}`
          : null;

      let next = createAgent(state, ev.agentId, {
        phase: 'thinking',
        taskIndex,
        taskDescription: description,
        dependencyHint,
      });
      next = {
        ...next,
        researchAgentIds: [...next.researchAgentIds, ev.agentId],
        researchSpawnCount: state.researchSpawnCount + 1,
        pendingTaskIndex: nextPendingIdx,
        pendingTaskDescription: nextPendingDesc,
      };
      return openThink(next, ev.agentId);
    }

    case 'agent:produce': {
      // Synth phase: accumulate into synth buffer.
      if (state.phase === 'synth' && state.synth.open) {
        return { ...state, synth: { ...state.synth, buffer: state.synth.buffer + ev.text } };
      }
      // Muted phases. 'recon' streams through the same path as 'research'
      // (its agent has taskIndex 0), so it's allowed past the gate.
      if (state.phase !== 'research' && state.phase !== 'recon') return state;

      const agent = state.agents.get(ev.agentId);
      if (!agent || agent.taskIndex === null) return state;

      let working = state;
      let acting = agent;

      // Content-phase tokens (post-</think>, pre-tool_call) — the model is
      // writing tool-call JSON. For the terminal `report` tool, the report
      // body lives inside that JSON. Stream into contentBuffer so it's
      // visible; cleared on tool_call / report when the structured event
      // lands.
      if (acting.phase === 'content') {
        return replaceAgent(working, acting.id, (a) => ({
          ...a,
          tokenCount: ev.tokenCount,
          contentBuffer: a.contentBuffer + ev.text,
        }));
      }

      // Recovery stream (post agent:done): `recoverInline` force-extracts the
      // report under an EAGER report grammar with no `<think>`/`</think>`.
      // Route it into contentBuffer (→ "Writing report") instead of opening a
      // think block, so a forced report isn't mislabeled as the agent
      // "Thinking". Cleared on agent:return/recovered. See docs/upstream-issues.md.
      if (acting.recovering) {
        return replaceAgent(working, acting.id, (a) => ({
          ...a,
          tokenCount: ev.tokenCount,
          contentBuffer: a.contentBuffer + ev.text,
        }));
      }

      // Re-enter thinking after tool_result / recovery / initial idle.
      if (acting.phase !== 'thinking' || acting.currentThinkId === null) {
        if (acting.phase === 'tool' || acting.phase === 'idle') {
          working = openThink(working, acting.id);
          acting = working.agents.get(acting.id)!;
        } else {
          // done — drop.
          return replaceAgent(working, acting.id, (a) => ({ ...a, tokenCount: ev.tokenCount }));
        }
      }

      const thinkId = acting.currentThinkId!;
      const item = acting.timeline.find((it) => it.id === thinkId);
      if (!item || item.kind !== 'think') return working;

      const combined = item.body + ev.text;
      const markerIdx = combined.indexOf(THINK_CLOSE);

      if (markerIdx === -1) {
        return replaceAgent(working, acting.id, (a) =>
          updateTimeline({ ...a, tokenCount: ev.tokenCount }, thinkId, (it) =>
            it.kind === 'think' ? { ...it, body: combined } : it,
          ),
        );
      }

      // Close on </think>. Anything AFTER </think> in this same produce event
      // is content-phase prose — seed the contentBuffer with it so no tokens
      // are lost at the boundary.
      const finalBody = combined.slice(0, markerIdx);
      const tail = combined.slice(markerIdx + THINK_CLOSE.length);
      const closed = closeThink(working, acting.id, finalBody);
      return replaceAgent(closed, acting.id, (a) => ({
        ...a,
        tokenCount: ev.tokenCount,
        contentBuffer: tail,
      }));
    }

    case 'agent:tool_call': {
      const agent = state.agents.get(ev.agentId);
      if (!agent) return state;

      // Force-close any live think block first.
      let working = state;
      if (agent.currentThinkId !== null) {
        const thinkItem = agent.timeline.find((it) => it.id === agent.currentThinkId);
        const finalBody = thinkItem && thinkItem.kind === 'think' ? thinkItem.body : '';
        working = closeThink(working, ev.agentId, finalBody);
      }

      // Skip timeline entry for non-research agents (synth may also emit tool_calls).
      if (working.agents.get(ev.agentId)?.taskIndex == null) {
        return replaceAgent(working, ev.agentId, (a) => ({
          ...a,
          phase: 'tool',
          toolCallCount: a.toolCallCount + 1,
        }));
      }

      // Terminal `report` tool: this fires at the stop token, but the report
      // already streamed live as a "Writing report" row (the model's report
      // body flowed into `contentBuffer` during the content phase — see the
      // marker extractor in Work.tsx). Pushing a generic tool_call row here
      // would render a misleading "Reading" timeline entry; instead just
      // advance phase/counts and clear the streamed buffer. `agent:return`
      // finalizes the report into a structured `report` item next.
      // Detection: the agent was mid-report stream iff its `contentBuffer`
      // (raw post-</think> tokens, not yet cleared) already holds the report
      // open marker. Belt-and-suspenders on the terminal tool name, which in
      // reasoning.run's own UI is always `report`.
      const acting = working.agents.get(ev.agentId);
      const wasReporting =
        ev.tool === 'report' ||
        (acting?.contentBuffer.includes('<parameter=result>') ?? false);
      if (wasReporting) {
        return replaceAgent(working, ev.agentId, (a) => ({
          ...a,
          phase: 'tool',
          toolCallCount: a.toolCallCount + 1,
          contentBuffer: '',
        }));
      }

      const id = working.nextTimelineId;
      const next = replaceAgent(working, ev.agentId, (a) =>
        pushTimeline(
          {
            ...a,
            phase: 'tool',
            toolCallCount: a.toolCallCount + 1,
            pendingToolCallId: id,
            contentBuffer: '',
          },
          {
            kind: 'tool_call',
            id,
            tool: ev.tool,
            argsSummary: formatArgSummary(ev.tool, ev.args),
          },
        ),
      );
      return { ...next, nextTimelineId: working.nextTimelineId + 1 };
    }

    case 'agent:tool_retry': {
      const agent = state.agents.get(ev.agentId);
      if (!agent) return state;
      return replaceAgent(state, ev.agentId, (a) => ({
        ...a,
        retry: { tool: ev.tool, retryAt: Date.now() + ev.retryAfterMs, attempt: ev.attempt },
      }));
    }

    case 'agent:tool_result': {
      const agent = state.agents.get(ev.agentId);
      if (!agent) return state;

      if (agent.taskIndex == null) {
        return replaceAgent(state, ev.agentId, (a) => ({ ...a, phase: 'idle', retry: null }));
      }

      const summary = summarizeResult(ev.tool, ev.result);
      const id = state.nextTimelineId;
      const hostsUnique = Array.from(new Set(summary.hosts));
      const next = replaceAgent(state, ev.agentId, (a) =>
        pushTimeline(
          { ...a, phase: 'idle', pendingToolCallId: null, retry: null },
          {
            kind: 'tool_result',
            id,
            tool: ev.tool,
            callId: agent.pendingToolCallId,
            byteLength: ev.result.length,
            preview: summary.preview,
            hosts: hostsUnique,
            resultCount: summary.resultCount,
            sources: summary.sources,
          },
        ),
      );
      return {
        ...next,
        nextTimelineId: state.nextTimelineId + 1,
        sourceCount: state.sourceCount + hostsUnique.length,
      };
    }

    case 'agent:tool_progress':
      return state;

    case 'agent:return':
    case 'agent:recovered': {
      const agent = state.agents.get(ev.agentId);
      if (!agent) return state;

      // Force-close any live think (recovery path may bypass </think>).
      let working = state;
      if (agent.currentThinkId !== null) {
        const thinkItem = agent.timeline.find((it) => it.id === agent.currentThinkId);
        const finalBody = thinkItem && thinkItem.kind === 'think' ? thinkItem.body : '';
        working = closeThink(working, ev.agentId, finalBody);
      }

      if (working.agents.get(ev.agentId)?.taskIndex == null) {
        return replaceAgent(working, ev.agentId, (a) => ({
          ...a,
          phase: 'done',
          endedAt: Date.now(),
          contentBuffer: '',
          recovering: false,
        }));
      }

      const id = working.nextTimelineId;
      const next = replaceAgent(working, ev.agentId, (a) =>
        pushTimeline(
          { ...a, phase: 'done', endedAt: Date.now(), contentBuffer: '', recovering: false },
          {
            kind: 'report',
            id,
            body: ev.result,
            tokenCount: a.tokenCount,
          },
        ),
      );

      // Push the finished panel into scrollback as a Static item, and drop
      // it from researchAgentIds so Narrative stops rendering it live. This
      // keeps the dynamic tree small (only currently-streaming agents stay
      // in Narrative), avoiding the clearTerminal-on-overflow scrollback
      // wipe at later phase transitions. The frozen panel survives in
      // terminal scrollback for the rest of the session.
      const finalAgent = next.agents.get(ev.agentId);
      const isResearch = next.researchAgentIds.includes(ev.agentId);
      const scrollback = isResearch && finalAgent
        ? [
            ...next.scrollback,
            {
              key: `agent-${ev.agentId}-${next.scrollback.length}`,
              kind: 'agent' as const,
              agent: finalAgent,
            },
          ]
        : next.scrollback;
      const researchAgentIds = isResearch
        ? next.researchAgentIds.filter((id) => id !== ev.agentId)
        : next.researchAgentIds;

      return {
        ...next,
        nextTimelineId: working.nextTimelineId + 1,
        scrollback,
        researchAgentIds,
      };
    }

    case 'agent:failed': {
      // Forced recovery FAILED (no result — e.g. KV exhausted mid-report decode →
      // `llama_decode failed`). The agent already showed "Writing report"
      // (agent:done set `recovering`); without this it spins forever. Mark it
      // terminally `failed` → cross glyph + frozen timer. There is no report.
      const agent = state.agents.get(ev.agentId);
      if (!agent || agent.phase === 'done' || agent.phase === 'failed') return state;
      let working = state;
      if (agent.currentThinkId !== null) {
        const thinkItem = agent.timeline.find((it) => it.id === agent.currentThinkId);
        const finalBody = thinkItem && thinkItem.kind === 'think' ? thinkItem.body : '';
        working = closeThink(working, ev.agentId, finalBody);
      }
      const next = replaceAgent(working, ev.agentId, (a) => ({
        ...a,
        phase: 'failed',
        endedAt: Date.now(),
        contentBuffer: '',
        recovering: false,
        failReason: ev.reason,
      }));
      // Move it out of the live tree into scrollback (like a finished agent) so
      // Narrative stops rendering it live — but with no `report` item.
      const finalAgent = next.agents.get(ev.agentId);
      const isResearch = next.researchAgentIds.includes(ev.agentId);
      const scrollback = isResearch && finalAgent
        ? [
            ...next.scrollback,
            {
              key: `agent-${ev.agentId}-${next.scrollback.length}`,
              kind: 'agent' as const,
              agent: finalAgent,
            },
          ]
        : next.scrollback;
      const researchAgentIds = isResearch
        ? next.researchAgentIds.filter((id) => id !== ev.agentId)
        : next.researchAgentIds;
      return { ...next, scrollback, researchAgentIds };
    }

    case 'agent:done': {
      // Do NOT mark the agent `done` here. In the stall-break path,
      // agent:done fires BEFORE recoverInline streams recovery tokens via
      // agent:produce → agent:recovered. Freezing to `done` would drop those
      // tokens. Force-close any live think and step back to `idle`, marking
      // the agent `recovering` so the produce handler routes the forced
      // report into contentBuffer (→ "Writing report") rather than a think
      // block. Only agent:return / agent:recovered mark `done`.
      //
      // Clear the stale contentBuffer too: if the agent was in `content` phase
      // when killed (mid tool-call JSON), the partial buffer never resolves to
      // a tool_call; recovery refills it with the actual forced report.
      const agent = state.agents.get(ev.agentId);
      if (!agent || agent.phase === 'done') return state;
      let working = state;
      if (agent.currentThinkId !== null) {
        const thinkItem = agent.timeline.find((it) => it.id === agent.currentThinkId);
        const finalBody = thinkItem && thinkItem.kind === 'think' ? thinkItem.body : '';
        working = closeThink(working, ev.agentId, finalBody);
      }
      return replaceAgent(working, ev.agentId, (a) => ({
        ...a,
        phase: 'idle',
        // Drop any partial content buffer: if the agent is being force-recovered
        // it never closed the terminal call, so recovery prose (refilled into
        // contentBuffer while `recovering`) drives the "Writing report" row now.
        contentBuffer: '',
        recovering: true,
      }));
    }

    case 'agent:tick':
      return {
        ...state,
        pressure: {
          pct: ev.nCtx > 0 ? Math.round((100 * ev.cellsUsed) / ev.nCtx) : 0,
          cellsUsed: ev.cellsUsed,
          nCtx: ev.nCtx,
        },
      };

    default:
      return state;
  }
}
