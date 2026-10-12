/**
 * The framework repairs only what it captured itself, and it repairs a dangling
 * envelope WHOLE. A reaped agent's terminal call is salvaged from a truncated
 * argument, and a model that restarts its envelope inside that argument leaves
 * the restart's reasoning close and its call fragment together at the tail —
 * stripping the call alone publishes the close as the last characters a reader
 * sees. The tags are the template's (`thinkingEndTags`), never a literal here:
 * Qwen closes with `</think>`, Magistral with `[/THINK]`.
 *
 * Observed 2026-09-20 on a forced reap (`salvage`, `terminal_cap`) of a Qwen3.5-4B
 * inquiry: the finding reached the document and `report.json` ending on `</think>`.
 * Receipt: docs/think-leak/recovery-receipt-2026-09-20-agent3.jsonl
 */
import { describe, it, expect } from 'vitest';
import { stripDanglingToolCall, extractTerminalResult } from '../src/capture';

const QWEN = '</think>';
const MAGISTRAL = '[/THINK]';

/** The bytes as the receipt recorded them, from the accepted result's tail. */
const RESTART_TAIL =
  'meworks)\n- Long-term drift analysis over extended inference sessions (mentioned but no specific data)\n'
  + '</think>\n\n<tool_call>\n<function=report>\n<parameter=result>\n'
  + '## KV Cache Quantization Survey for Long-Context LLM Serving\n\n### Framework Sup';

describe('stripDanglingToolCall', () => {
  it('leaves prose alone', () => {
    expect(stripDanglingToolCall('A finding with no markers.', [QWEN])).toBe('A finding with no markers.');
  });

  it('leaves a COMPLETE tool call alone — it is data the model closed', () => {
    const text = 'Here is one:\n<tool_call>\n{"name":"x"}\n</tool_call>\nand more prose.';
    expect(stripDanglingToolCall(text, [QWEN])).toBe(text);
  });

  it('removes a dangling call fragment', () => {
    expect(stripDanglingToolCall('The finding.\n\n<tool_call>\n<function=report>\n<param', [QWEN]))
      .toBe('The finding.');
  });

  it('removes the restarted envelope WHOLE — the close belongs to the fragment', () => {
    const out = stripDanglingToolCall(RESTART_TAIL, [QWEN]);
    expect(out).not.toContain(QWEN);
    expect(out.endsWith('(mentioned but no specific data)')).toBe(true);
  });

  it('keeps a lone trailing close — only the close that opens a stripped fragment goes', () => {
    // A close with no call after it is not evidence of a restart, and a finding may name the
    // tag in prose. Removing it unconditionally deletes text the model meant to keep.
    expect(stripDanglingToolCall('The finding.\n</think>', [QWEN])).toBe('The finding.\n</think>');
    expect(stripDanglingToolCall('The reasoning terminator is </think>', [QWEN]))
      .toBe('The reasoning terminator is </think>');
    expect(stripDanglingToolCall('</think>', [QWEN])).toBe('</think>');
  });

  it('keeps a close the prose genuinely contains mid-body', () => {
    const text = 'The model writes </think> when it stops reasoning.\nThat is the finding.';
    expect(stripDanglingToolCall(text, [QWEN])).toBe(text);
  });

  it('uses the template\'s tag, not a literal — Magistral closes differently', () => {
    expect(stripDanglingToolCall('The finding.\n[/THINK]\n<tool_call>\n<func', [MAGISTRAL])).toBe('The finding.');
    expect(stripDanglingToolCall('The finding.\n[/THINK]\n<tool_call>\n<func', [QWEN])).toBe('The finding.\n[/THINK]');
  });

  it('strips the call alone when the template does not think', () => {
    expect(stripDanglingToolCall('The finding.\n<tool_call>\n<func', [])).toBe('The finding.');
    expect(stripDanglingToolCall('The finding.\n</think>', [])).toBe('The finding.\n</think>');
  });
});

describe('extractTerminalResult', () => {
  it('reads the field from a complete call', () => {
    expect(extractTerminalResult(JSON.stringify({ result: 'the findings' }))).toBe('the findings');
  });

  it('salvages the partial when the cap cut the argument mid-string', () => {
    expect(extractTerminalResult('{"result": "the findings so far, cut')).toBe('the findings so far, cut');
  });
});

/**
 * A salvage that stops inside a fenced block hands the settling pass an open
 * fence, and a model continues what it is handed. The frame closes it at the
 * capture, beside the envelope strip, and only for its own captures.
 */
import { closeOpenFence, repairCapture } from '../src/capture';

describe('closeOpenFence', () => {
  it('leaves prose and balanced fences alone', () => {
    expect(closeOpenFence('Plain finding.')).toBe('Plain finding.');
    const balanced = 'Before\n\n```ts\nconst a = 1;\n```\n\nAfter';
    expect(closeOpenFence(balanced)).toBe(balanced);
  });

  it('closes a fence the cut left open, on its own line', () => {
    expect(closeOpenFence('Before\n\n```ts\nconst a = ')).toBe('Before\n\n```ts\nconst a = \n```');
    expect(closeOpenFence('Before\n\n~~~\nraw\n')).toBe('Before\n\n~~~\nraw\n~~~');
  });

  it('a fence marker inside a line is not a fence', () => {
    const inline = 'Use ``` to open a block, like `a```b`.';
    expect(closeOpenFence(inline)).toBe(inline);
  });

  it('a marker-led line with text after it is content, not a close', () => {
    const balanced = '```text\n```not-a-closing-fence\n```';
    expect(closeOpenFence(balanced)).toBe(balanced);
  });

  it('closes with the opener\'s own marker when fences are mixed', () => {
    expect(closeOpenFence('```\nfirst\n```\n\n~~~py\nx = ')).toBe('```\nfirst\n```\n\n~~~py\nx = \n~~~');
  });
});

describe('repairCapture', () => {
  it('strips the dangling envelope first, then closes an open fence', () => {
    const cut = 'Finding:\n\n```json\n{"a": 1' + '\n' + QWEN + '\n<tool_call>\n<function=report>';
    expect(repairCapture(cut, [QWEN])).toBe('Finding:\n\n```json\n{"a": 1\n```');
  });
});

/**
 * A salvage of a call cut before its result began has nothing to keep. The raw
 * arguments are a value only when they are a WHOLE call (a typed terminal with
 * no `result` field); a truncated call that never opened its result is empty,
 * so the salvage fails as `empty_terminal_result` instead of settling a brace.
 */
import { salvageTerminalResult } from '../src/capture';

describe('salvageTerminalResult', () => {
  it('a whole call: the result field, or the whole arguments for a typed terminal', () => {
    expect(salvageTerminalResult('{"result":"The finding"}')).toBe('The finding');
    expect(salvageTerminalResult('{"answer":42,"sources":[]}')).toBe('{"answer":42,"sources":[]}');
  });

  it('a call cut inside its result keeps the partial string', () => {
    expect(salvageTerminalResult('{"result":"The first finding, and mo')).toBe('The first finding, and mo');
  });

  it('a call cut inside an escape keeps the text before the escape', () => {
    expect(salvageTerminalResult('{"result":"The finding \\u20')).toBe('The finding ');
    expect(salvageTerminalResult('{"result":"The finding \\')).toBe('The finding ');
    expect(salvageTerminalResult('{"result":"Line one\\nLine tw')).toBe('Line one\nLine tw');
  });

  it('a call cut before its result began keeps nothing', () => {
    expect(salvageTerminalResult('{')).toBe('');
    expect(salvageTerminalResult('')).toBe('');
    expect(salvageTerminalResult('{"resu')).toBe('');
  });
});
