import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/prompt';

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
});
