/**
 * Effection's normative contract (AGENTS.md, v4) has two rules the pool can
 * break silently, so they are checked mechanically here rather than
 * remembered.
 *
 * 1. Cleanup that needs `yield*` must go through `ensure()`, never a `finally`
 *    block. When a task is halted its generator is unwound with `return()`;
 *    a `finally` that yields suspends the frame, the runtime resumes it with
 *    `next()`, and the frame is no longer unwinding — once cleanup finishes,
 *    execution continues past the operation that was being halted. The halt
 *    is lost.
 *
 * 2. A `Signal` is a bridge from a plain synchronous callback into a stream.
 *    It must not be used for messaging between operations; that is a
 *    `Channel` or a `Queue`. The pool's one legitimate signal is the bridge
 *    for a tool's `onProgress` callback.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const ROOTS = ['packages/agents/src', 'packages/rig/src'];

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) yield p;
  }
}

/** Source with comments and string bodies blanked, so a rule reads code only. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:\\.|[^'\\\n])*'/g, m => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, m => ' '.repeat(m.length));
}

/** Every `finally { ... }` block body, found by brace matching on code only. */
function* finallyBodies(code: string): Generator<{ line: number; body: string }> {
  const re = /\bfinally\s*\{/g;
  for (const m of code.matchAll(re)) {
    let depth = 1; let i = m.index! + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) { if (code[i] === '{') depth++; else if (code[i] === '}') depth--; i++; }
    yield { line: code.slice(0, m.index).split('\n').length, body: code.slice(start, i - 1) };
  }
}

describe('the pool keeps Effection\'s contract', () => {
  it('no `yield*` inside a `finally` block — async cleanup goes through ensure()', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of tsFiles(join(REPO, root))) {
        const code = codeOnly(readFileSync(file, 'utf8'));
        for (const f of finallyBodies(code)) {
          if (/\byield\*/.test(f.body)) hits.push(`${relative(REPO, file)}:${f.line}`);
        }
      }
    }
    expect(hits, `finally blocks that yield:\n  ${hits.join('\n  ')}`).toEqual([]);
  });

  it('createSignal is used once in the runtime: the bridge from a tool\'s onProgress callback', () => {
    const sites: string[] = [];
    for (const file of tsFiles(join(REPO, 'packages/agents/src'))) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/\bcreateSignal\s*[<(]/g)) {
        sites.push(`${relative(REPO, file)}:${code.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(sites, `signal construction sites:\n  ${sites.join('\n  ')}`).toHaveLength(1);
    expect(sites[0]).toMatch(/^packages\/agents\/src\/agent-pool\.ts:/);
  });
});
