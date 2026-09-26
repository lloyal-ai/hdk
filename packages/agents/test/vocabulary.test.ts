/**
 * The agents package knows no product. It knows no tool but Delegate (the B7
 * grep gates), and the same law holds for its prose: a docblock is public
 * documentation (`@category Agents` becomes the hdk-docs), so an example that
 * reads "Research task:" teaches the framework in one harness's words to every
 * other harness's developer. This scan holds the package's SOURCE, comments
 * included, to the framework's own vocabulary.
 *
 * An ability's own protocol name (`web_research`) is the ability's word, not a
 * product's; the word boundary leaves it alone. "row" stays legal: image rows
 * are the embedding rail's, not a spreadsheet's.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const PRODUCT_WORDS = /\b(research|brief|sheet|synth[a-z]*)\b/i;

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) yield p;
  }
}

describe('the agents package names no product', () => {
  it('research, brief, sheet and synth appear nowhere in packages/agents/src', () => {
    const hits: string[] = [];
    for (const file of tsFiles(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const m = PRODUCT_WORDS.exec(line);
        if (m) hits.push(`${relative(SRC, file)}:${i + 1}: ${m[0]}`);
      });
    }
    expect(hits, 'product vocabulary in the framework').toEqual([]);
  });
});
