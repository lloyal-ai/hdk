/**
 * Tests for the install-time attention-surface RENDER path. The tarball is
 * Ed25519-verified for authenticity, but its `attention-surface.json` is still
 * publisher-authored JSON whose SHAPE is not validated — a buggy or hostile
 * publisher can ship malformed fields. `formatAttentionSurface` must be total:
 * it degrades a bad field rather than throwing (which would crash install,
 * breaking the "never blocks" promise).
 */
import { describe, it, expect } from 'vitest';
import { formatAttentionSurface } from '../src/commands/install';
import type { AttentionSurface } from '../src/describe';

// Cast helper: feed deliberately ill-typed shapes through the typed signature.
const surface = (raw: unknown): AttentionSurface => raw as AttentionSurface;

describe('formatAttentionSurface — malformed publisher input', () => {
  it('renders a well-formed surface', () => {
    const out = formatAttentionSurface(
      surface({
        protocol: { name: 'web_research', useWhen: 'questions about the live web' },
        tools: [{ name: 'web_search', description: 'search the web', protected: false }],
        configSchema: { properties: { apiKey: { type: 'string', 'x-secret': true } } },
        skill: 'line 1\nline 2',
      }),
      'web',
    );
    expect(out).toContain('web_research');
    expect(out).toContain('• web_search — search the web');
    expect(out).toContain('apiKey (string, secret)');
    expect(out).toContain('Tools (1)');
  });

  it('does not throw when tools contains null / non-object entries', () => {
    let out = '';
    expect(() => {
      out = formatAttentionSurface(surface({ tools: [null, 42, { name: 'ok' }, undefined] }), 'x');
    }).not.toThrow();
    // The two malformed entries are skipped; only the valid one renders.
    expect(out).toContain('Tools (1)');
    expect(out).toContain('• ok');
  });

  it('does not throw when a tool name/description is the wrong type', () => {
    let out = '';
    expect(() => {
      out = formatAttentionSurface(surface({ tools: [{ name: 123, description: { nested: true } }] }), 'x');
    }).not.toThrow();
    expect(out).toContain('• (unnamed)');
  });

  it('does not throw when skill is a non-string', () => {
    expect(() => formatAttentionSurface(surface({ skill: 123 }), 'x')).not.toThrow();
    expect(() => formatAttentionSurface(surface({ skill: { a: 1 } }), 'x')).not.toThrow();
  });

  it('does not throw when configSchema.properties is malformed', () => {
    expect(() => formatAttentionSurface(surface({ configSchema: { properties: { k: null } } }), 'x')).not.toThrow();
    expect(() => formatAttentionSurface(surface({ configSchema: 'nonsense' }), 'x')).not.toThrow();
  });

  it('does not throw on an empty object', () => {
    let out = '';
    expect(() => {
      out = formatAttentionSurface(surface({}), 'x');
    }).not.toThrow();
    expect(out).toContain('Tools (0)');
  });
});
