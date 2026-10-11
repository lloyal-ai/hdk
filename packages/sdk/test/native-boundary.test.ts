import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

const native = vi.hoisted(() => ({ createContext: vi.fn(), loads: 0 }));
vi.mock('@lloyal-labs/lloyal.node', () => { native.loads++; return native; });

describe('SDK native context boundary', () => {
  it('keeps the main entry independent of native loading', async () => {
    const sdk = await import('../src/index');
    expect(sdk.Branch).toBeTypeOf('function');
    expect(sdk).not.toHaveProperty('createContext');
    expect(native.loads).toBe(0);
    expect(native.createContext).not.toHaveBeenCalled();
  });

  it('constructs a context through the Node entry with the caller’s model and backend options', async () => {
    const sdk = await import('../src/node');
    const options = { modelPath: 'asr.gguf', mmprojPath: 'audio-projector.gguf', nCtx: 4096 };
    const load = { gpuVariant: 'cuda' as const };
    const context = { supportsAudio: () => true, audioSampleRate: () => 16000 };
    native.createContext.mockResolvedValueOnce(context);
    expect(await sdk.createContext(options, load)).toBe(context);
    expect(native.createContext).toHaveBeenCalledWith(options, load);
  });

  it('routes production context construction through the SDK', () => {
    const root = resolve(import.meta.dirname, '../..');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter(file => /\/src\/.*\.tsx?$/.test(file) && !file.startsWith('sdk/'));
    expect(files.length).toBeGreaterThan(0);
    const imports = files.flatMap(file => {
      const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest);
      return source.statements.filter(ts.isImportDeclaration)
        .filter(statement => ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text === '@lloyal-labs/lloyal.node')
        .map(statement => `${file}: ${statement.importClause?.getText(source)}`);
    });
    // Backend discovery and file hashing do not create or operate a context.
    expect(imports.sort()).toEqual([
      'rig/src/resident-context.ts: { resolveBackendPackDirSync }',
      'rig/src/resources/files.ts: { loadBinary }',
    ]);
  });
});
