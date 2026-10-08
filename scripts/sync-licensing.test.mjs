import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderFaq, syncLicensing } from './sync-licensing.mjs';

const fsl = '# Functional Source License, Version 1.1, Apache 2.0 Future License\n\nFixture license, never rewritten.\n';
const grant = '# Developer Grant\n\nFixture grant.\n';
const faq = '# Licensing FAQ\n\nFixture FAQ.\n';
const legalFiles = ['dist/', 'LICENSE', 'GRANT.md', 'LICENSE-FAQ.md'];
const read = path => readFileSync(path, 'utf8');
function write(path, content) {
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'lloyal-licensing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hdkDir = join(directory, 'hdk');
  mkdirSync(hdkDir);
  write(join(hdkDir, 'package.json'), { workspaces: ['packages/*'] });
  write(join(hdkDir, 'LICENSE'), fsl);
  write(join(hdkDir, 'GRANT.md'), grant);
  write(join(hdkDir, 'LICENSE-FAQ.md'), faq);
  const addPackage = (name, license = fsl, declaration = 'SEE LICENSE IN LICENSE') => {
    const packageDir = join(hdkDir, 'packages', name);
    mkdirSync(packageDir, { recursive: true });
    write(join(packageDir, 'package.json'), { name, version: '1.0.0', license: declaration, files: legalFiles });
    write(join(packageDir, 'LICENSE'), license);
    return packageDir;
  };
  const runtime = addPackage('runtime');
  const apache = addPackage('channel-verify', 'Apache License\n', 'Apache-2.0');
  const external = () => {
    const docsDir = join(directory, 'hdk-docs');
    const nativeDir = join(directory, 'lloyal.node');
    const kernelDir = join(directory, 'liblloyal');
    mkdirSync(join(docsDir, 'licensing'), { recursive: true });
    write(join(docsDir, 'licensing', 'faq.md'), '---\ntitle: Licensing FAQ\n---\n\nCanonical FAQ.\n');
    for (const destination of [nativeDir, kernelDir]) {
      mkdirSync(destination);
      write(join(destination, 'LICENSE'), fsl);
    }
    return { docsDir, nativeDir, kernelDir };
  };
  return { hdkDir, runtime, apache, addPackage, external };
}

test('standalone sync copies both documents, discovers new FSL workspaces and preserves licenses', t => {
  const { hdkDir, runtime, apache, addPackage } = fixture(t);
  const ability = addPackage('new-ability');
  assert.deepEqual(syncLicensing({ hdkDir }), { checked: 4, changed: 4, packages: 2 });
  for (const target of [runtime, ability]) {
    assert.equal(read(join(target, 'GRANT.md')), grant);
    assert.equal(read(join(target, 'LICENSE-FAQ.md')), faq);
    assert.equal(read(join(target, 'LICENSE')), fsl);
  }
  assert.equal(read(join(hdkDir, 'LICENSE')), fsl);
  assert.equal(read(join(apache, 'LICENSE')), 'Apache License\n');
  assert.equal(existsSync(join(apache, 'GRANT.md')), false);
  assert.equal(existsSync(join(apache, 'LICENSE-FAQ.md')), false);
  assert.equal(syncLicensing({ hdkDir, check: true }).changed, 0);
});

test('read-only check reports both missing and stale files without repairing them', t => {
  const { hdkDir, runtime } = fixture(t);
  syncLicensing({ hdkDir });
  write(join(runtime, 'GRANT.md'), 'drift\n');
  rmSync(join(runtime, 'LICENSE-FAQ.md'));
  assert.throws(() => syncLicensing({ hdkDir, check: true }), error => {
    assert.match(error.message, /GRANT\.md/);
    assert.match(error.message, /LICENSE-FAQ\.md/);
    return true;
  });
  assert.equal(read(join(runtime, 'GRANT.md')), 'drift\n');
  assert.equal(existsSync(join(runtime, 'LICENSE-FAQ.md')), false);
});

test('missing package publication entries fail before copies are written', t => {
  const { hdkDir, runtime } = fixture(t);
  const path = join(runtime, 'package.json');
  const manifest = JSON.parse(read(path));
  for (const missing of ['LICENSE', 'GRANT.md', 'LICENSE-FAQ.md']) {
    write(path, { ...manifest, files: legalFiles.filter(file => file !== missing) });
    assert.throws(() => syncLicensing({ hdkDir }), /must include .* in its files array/);
    assert.equal(existsSync(join(runtime, 'GRANT.md')), false);
  }
});

test('a missing declared workspace or package LICENSE is an error', t => {
  const { hdkDir, runtime } = fixture(t);
  rmSync(join(runtime, 'LICENSE'));
  assert.throws(() => syncLicensing({ hdkDir }), /Cannot read required file .*LICENSE/);
  write(join(hdkDir, 'package.json'), { workspaces: ['packages/not-present'] });
  assert.throws(() => syncLicensing({ hdkDir }), /Workspace has no package\.json/);
});

test('changed FSL terms require review rather than being overwritten', t => {
  const { hdkDir, runtime } = fixture(t);
  write(join(runtime, 'LICENSE'), fsl + '\nCustom terms.\n');
  assert.throws(() => syncLicensing({ hdkDir }), /differs from HDK LICENSE/);
  assert.equal(read(join(runtime, 'LICENSE')), fsl + '\nCustom terms.\n');
  assert.equal(existsSync(join(runtime, 'GRANT.md')), false);
});

test('manifest cannot mislabel a package that has an FSL LICENSE', t => {
  const { hdkDir, runtime } = fixture(t);
  const path = join(runtime, 'package.json');
  write(path, { ...JSON.parse(read(path)), license: 'Apache-2.0' });
  assert.throws(() => syncLicensing({ hdkDir }), /declares Apache-2\.0 but contains an FSL/);
});

test('cross-repository sync needs every explicit path and fails before local writes', t => {
  const { hdkDir, runtime } = fixture(t);
  assert.throws(() => syncLicensing({ hdkDir, docsDir: '/missing' }), /requires --docs-dir, --native-dir and --kernel-dir together/);
  assert.throws(() => syncLicensing({ hdkDir, docsDir: '/missing-docs', nativeDir: '/missing-native', kernelDir: '/missing-kernel' }), /Required directory does not exist/);
  assert.equal(existsSync(join(runtime, 'GRANT.md')), false);
});

test('full sync generates FAQ from docs and updates every root and workspace', t => {
  const { hdkDir, runtime, external } = fixture(t);
  const paths = external();
  const source = read(join(paths.docsDir, 'licensing', 'faq.md'));
  const expectedFaq = renderFaq(source);
  assert.deepEqual(syncLicensing({ hdkDir, ...paths }), { checked: 7, changed: 7, packages: 1 });
  for (const target of [hdkDir, runtime, paths.nativeDir, paths.kernelDir]) {
    assert.equal(read(join(target, 'GRANT.md')), grant);
    assert.equal(read(join(target, 'LICENSE-FAQ.md')), expectedFaq);
    assert.equal(read(join(target, 'LICENSE')), fsl);
  }
  assert.equal(read(join(paths.docsDir, 'licensing', 'faq.md')), source);
  assert.equal(syncLicensing({ hdkDir, ...paths, check: true }).changed, 0);
  write(join(paths.docsDir, 'licensing', 'faq.md'), source + '\nUpdated FAQ.\n');
  assert.throws(() => syncLicensing({ hdkDir, ...paths, check: true }), /Licensing copies are missing or out of date/);
  assert.equal(read(join(hdkDir, 'LICENSE-FAQ.md')), expectedFaq);
});

test('a malformed canonical FAQ cannot leave a partially updated stack', t => {
  const { hdkDir, runtime, external } = fixture(t);
  const paths = external();
  write(join(paths.docsDir, 'licensing', 'faq.md'), '---\ntitle: Broken\n');
  assert.throws(() => syncLicensing({ hdkDir, ...paths }), /unclosed YAML frontmatter/);
  assert.equal(read(join(hdkDir, 'LICENSE-FAQ.md')), faq);
  assert.equal(existsSync(join(runtime, 'GRANT.md')), false);
  assert.equal(existsSync(join(paths.nativeDir, 'GRANT.md')), false);
});

test('frontmatter removal preserves markdown horizontal rules and handles CRLF or no frontmatter', () => {
  const body = 'First paragraph.\n\n---\n\nSecond paragraph.\n';
  assert.ok(renderFaq('---\ntitle: Licensing FAQ\n---\n\n' + body).endsWith(body));
  assert.ok(renderFaq(('---\n---\n' + body).replaceAll('\n', '\r\n')).endsWith(body));
  assert.ok(renderFaq(body).endsWith(body));
  assert.throws(() => renderFaq('---\ntitle: Empty\n---\n'), /no content/);
});
