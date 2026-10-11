import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const { build } = createRequire(import.meta.url)('vite');

it('emits the exported PCM worklet as an executable asset in a bundled consumer', async () => {
  const require = createRequire(new URL('../package.json', import.meta.url));
  const worklet = require.resolve('@lloyal-labs/ui/pcm-worklet');
  const dir = mkdtempSync(join(tmpdir(), 'lloyal-worklet-'));
  try {
    const entry = join(dir, 'entry.js');
    writeFileSync(entry, `import url from ${JSON.stringify(`${worklet}?url&no-inline`)}; globalThis.workletUrl = url;`);
    const result = await build({
      configFile: false, root: dir, logLevel: 'silent', base: './',
      build: { write: false, rollupOptions: { input: entry } },
    });
    const output = (Array.isArray(result) ? result[0] : result) as { output: Array<{ type: string; fileName: string; source?: string | Uint8Array; code?: string }> };
    const asset = output.output.find(file => file.type === 'asset' && file.fileName.endsWith('.js'));
    expect(asset).toBeDefined();
    const source = String(asset!.source);
    expect(source).toContain("registerProcessor('lloyal-pcm-capture', PcmCapture)");
    expect(source).not.toMatch(/\bimport\s/);
    const chunk = output.output.find(file => file.type === 'chunk')!;
    expect(chunk.code).toContain(basename(asset!.fileName));
    expect(chunk.code).not.toContain('data:text/javascript');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
