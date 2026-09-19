/**
 * The terminal call's capture — the ONE extractor, shared by the policy (a
 * voluntary return) and the applier (a salvaged or recovered report), so the
 * two paths cannot disagree on what a call without a `result` field yields.
 */

/** Strip a trailing UNCLOSED `<tool_call>` fragment from text captured as an
 *  agent result — a truncated call must not ride into another agent's prompt
 *  as an in-context demonstration of emitting tool calls. Complete blocks
 *  are left alone.
 *
 *  Who strips: an output that CAPTURES (rig's `defineOutput`) strips the text
 *  it derives before any capture appends to it — a trailer appended after the
 *  fragment would hide it from this `$`-anchored match. The applier strips
 *  what never passes a capture: a free-text return, the salvage of a terminal
 *  call cut mid-argument (the schema rejects it, so no `onReturn` sees it),
 *  and a return through an output that captures nothing. */
export function stripDanglingToolCall(text: string): string {
  return text.replace(/<tool_call>(?:(?!<\/tool_call>)[\s\S])*$/, '').trimEnd();
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
