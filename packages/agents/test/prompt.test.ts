import { describe, it, expect } from 'vitest';
import { renderTemplate, guardedInput } from '../src/prompt';
import type { MissingInput } from '../src/prompt';

describe('renderTemplate', () => {
  it('interpolates variables', () => {
    const result = renderTemplate('Hello <%= it.name %>', { name: 'World' });
    expect(result).toBe('Hello World');
  });

  it('handles conditionals', () => {
    const tpl = '<% if (it.show) { %>visible<% } %>';
    expect(renderTemplate(tpl, { show: true })).toContain('visible');
    expect(renderTemplate(tpl, { show: false })).not.toContain('visible');
  });

  it('handles loops', () => {
    const tpl = '<% it.items.forEach(function(x) { %><%= x %> <% }) %>';
    const result = renderTemplate(tpl, { items: ['a', 'b', 'c'] });
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('c');
  });

  it('does not auto-escape HTML', () => {
    const result = renderTemplate('<%= it.html %>', { html: '<b>bold</b>' });
    expect(result).toBe('<b>bold</b>');
  });

  it('a key the template reads and the data does not name is reported and rendered empty — never the word "undefined"', () => {
    const misses: MissingInput[] = [];
    const out = renderTemplate('Hello <%= it.name %>, <%= it.nmae %>.', { name: 'W' }, { name: 'greeting', onMissing: (m) => misses.push(m) });
    expect(out).toBe('Hello W, .');
    expect(misses).toEqual([{ prompt: 'greeting', key: 'nmae' }]);
  });

  it('a key given as undefined is given; a symbol read is not a key; and a strict watcher makes the miss a throw', () => {
    const misses: MissingInput[] = [];
    expect(renderTemplate('<% if (it.maybe) { %>yes<% } %>no', { maybe: undefined }, { onMissing: (m) => misses.push(m) })).toBe('no');
    expect(misses).toEqual([]);
    expect(() => renderTemplate('<%= it.x %>', {}, { name: 't', onMissing: ({ prompt, key }) => { throw new Error(`${prompt}: "${key}" not given`); } })).toThrow('t: "x" not given');
  });
});

describe('guardedInput', () => {
  it('reads what was given, reports what was not, and answers a spread with the keys it has', () => {
    const misses: MissingInput[] = [];
    const g = guardedInput('p', { a: 1 }, (m) => misses.push(m));
    expect(g.a).toBe(1);
    expect(g.b).toBe('');
    expect({ ...g }).toEqual({ a: 1 });
    expect(misses).toEqual([{ prompt: 'p', key: 'b' }]);
  });
});
