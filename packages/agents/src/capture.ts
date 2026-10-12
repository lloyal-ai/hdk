/**
 * The terminal call's capture — the ONE extractor, shared by the policy (a
 * voluntary return) and the applier (a salvaged or recovered report), so the
 * two paths cannot disagree on what a call without a `result` field yields.
 */

/** Strip a trailing UNCLOSED envelope from text captured as an agent result —
 *  a truncated call must not ride into another agent's prompt as an in-context
 *  demonstration of emitting tool calls. Complete blocks are left alone.
 *
 *  A restart is stripped WHOLE. A model reaped mid-argument often begins the
 *  envelope again inside the string it was writing — closing reasoning, then
 *  opening a fresh call — so the fragment at the tail is `<close><tool_call>…`.
 *  Removing the call alone publishes the close as the last characters a reader
 *  sees. `thinkingEndTags` are the template's own closes, carried on the agent's
 *  format (Qwen `</think>`, Magistral `[/THINK]`); empty when it does not think.
 *  Only a TRAILING close goes — prose that mentions a tag mid-body is prose.
 *
 *  Who strips: the framework repairs only what it captured ITSELF — the
 *  frame's default capture of a terminal call, a free-text return, the salvage
 *  of a call cut mid-argument. A contributor's capture (a tool's `onReturn`, a
 *  harness's) keeps its bytes: typed data may legitimately contain the marker,
 *  and only the capture knows which of its strings is prose. A capture that
 *  appends to prose (a citation trailer) strips first, itself, or the
 *  fragment is buried where this end-anchored match cannot see it. */
export function stripDanglingToolCall(text: string, thinkingEndTags: readonly string[] = []): string {
  const open = text.search(/<tool_call>(?:(?!<\/tool_call>)[\s\S])*$/);
  if (open === -1) return text.trimEnd();
  const kept = text.slice(0, open).trimEnd();
  // The close goes only when it is the text IMMEDIATELY before the fragment — that is the
  // restart. A close anywhere else is prose the model wrote (a finding may well name the
  // tag), and a result that is nothing but a close is not evidence of a restart at all.
  const close = thinkingEndTags.find((tag) => tag !== '' && kept.endsWith(tag));
  if (close !== undefined) return kept.slice(0, -close.length).trimEnd();
  return kept;
}

/** Extract the terminal-tool result string from a parsed (possibly TRUNCATED)
 *  tool call: valid JSON → `.result`; a token-stop cuts mid-call, so salvage
 *  the `result` body from the partial and unescape it; else the raw arguments
 *  (a terminal tool whose value is the whole call, read back typed by its output). */
export function extractTerminalResult(args: string): string {
  try {
    const r = JSON.parse(args).result;
    if (typeof r === 'string') return r;
  } catch { /* truncated or non-JSON — salvage the partial below */ }
  const m = partialResult(args);
  return m ?? args;
}

/** The capture of a call the POOL ended: a salvage, or a report token-stopped
 *  at its share. A whole call reads as a voluntary one does; a call cut inside
 *  its result keeps the partial string; a call cut before its result began has
 *  nothing to keep and says so with the empty string, so the salvage fails as
 *  `empty_terminal_result` instead of settling a brace as the result. */
export function salvageTerminalResult(args: string): string {
  try {
    const r = JSON.parse(args).result;
    return typeof r === 'string' ? r : args;
  } catch { /* truncated — the partial result or nothing */ }
  return partialResult(args) ?? '';
}

/** The `result` string of a call cut mid-argument, unescaped; null when it never began.
 *  A cut inside an escape (`\u20`, a lone backslash) drops the fragment, not the text before it. */
function partialResult(args: string): string | null {
  const m = args.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  const body = m[1].replace(/\\u[0-9a-fA-F]{0,3}$/, '').replace(/\\+$/, '');
  try { return JSON.parse(`"${body}"`); } catch { return null; }
}

/** Close a fenced block the cut left open. A salvage can stop inside a fence,
 *  and a settling pass handed an open fence continues it as code; the frame
 *  closes it with the opener's own marker, on its own line. Only a line that
 *  BEGINS with the marker opens or closes a fence; a marker mid-line is prose. */
export function closeOpenFence(text: string): string {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const [, marker, rest] = m;
    // An opener may carry an info string; a closer is the marker and nothing but whitespace.
    if (open === null) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && rest.trim() === '') open = null;
  }
  if (open === null) return text;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${open}`;
}

/** The frame's whole repair of a capture it made itself: the dangling envelope
 *  goes first, so a fence the restart began is not what gets closed. */
export function repairCapture(text: string, thinkingEndTags: readonly string[] = []): string {
  return closeOpenFence(stripDanglingToolCall(text, thinkingEndTags));
}
