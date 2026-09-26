/** The citation weave: a report's grammar-forced sources are woven into its findings at capture. */
import { describe, it, expect } from 'vitest';
import { weaveSourcesIntoResult } from '../src/tools/weave-sources';

describe('weaveSourcesIntoResult', () => {
  it('wraps each bare url with its title, leaves one already linked alone, and appends the list', () => {
    const out = weaveSourcesIntoResult('See https://a.io/x and [done](https://b.io).', [
      { title: 'A', url: 'https://a.io/x' }, { title: 'B', url: 'https://b.io' },
    ]);
    expect(out).toContain('See [A](https://a.io/x) and [done](https://b.io).');
    expect(out).toMatch(/Sources:\n- \[A\]\(https:\/\/a\.io\/x\)\n- \[B\]\(https:\/\/b\.io\)$/);
  });
});
