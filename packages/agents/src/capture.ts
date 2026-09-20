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
 *  sees. `thinkingEndTag` is the template's own close, carried on the agent's
 *  format (Qwen `</think>`, Magistral `[/THINK]`); empty when it does not think.
 *  Only a TRAILING close goes — prose that mentions the tag mid-body is prose.
 *
 *  Who strips: the framework repairs only what it captured ITSELF — the
 *  frame's default capture of a terminal call, a free-text return, the salvage
 *  of a call cut mid-argument. A contributor's capture (a tool's `onReturn`, a
 *  harness's) keeps its bytes: typed data may legitimately contain the marker,
 *  and only the capture knows which of its strings is prose. A capture that
 *  appends to prose (a citation trailer) strips first, itself, or the
 *  fragment is buried where this end-anchored match cannot see it. */
export function stripDanglingToolCall(text: string, thinkingEndTag = ''): string {
  const open = text.search(/<tool_call>(?:(?!<\/tool_call>)[\s\S])*$/);
  if (open === -1) return text.trimEnd();
  const kept = text.slice(0, open).trimEnd();
  // The close goes only when it is the text IMMEDIATELY before the fragment — that is the
  // restart. A close anywhere else is prose the model wrote (a finding may well name the
  // tag), and a result that is nothing but a close is not evidence of a restart at all.
  if (thinkingEndTag && kept.endsWith(thinkingEndTag)) return kept.slice(0, -thinkingEndTag.length).trimEnd();
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
  const m = args.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) {
    try { return JSON.parse(`"${m[1].replace(/\\+$/, '')}"`); } catch { /* fall through to raw */ }
  }
  return args;
}
