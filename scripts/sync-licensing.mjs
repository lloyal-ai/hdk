#!/usr/bin/env node
// No dependencies or network: a standalone checkout can verify its package copies.
import { globSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultHdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const legalFiles = ['LICENSE', 'GRANT.md', 'LICENSE-FAQ.md'];
const fslHeader = '# Functional Source License, Version 1.1, Apache 2.0 Future License';

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read required file ${path}: ${error.code}`);
  }
}

function requireDirectory(path) {
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Required directory does not exist: ${path}`);
  }
}

export function renderFaq(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  let body = normalized;
  if (normalized.startsWith('---\n')) {
    const lines = normalized.split('\n');
    const closing = lines.findIndex((line, index) => index > 0 && line === '---');
    if (closing === -1) throw new Error('Canonical FAQ has unclosed YAML frontmatter');
    body = lines.slice(closing + 1).join('\n');
  }
  if (!body.trim()) throw new Error('Canonical FAQ has no content');
  return '# Licensing FAQ\n\n'
    + '> Canonical version at https://docs.lloyal.ai/licensing/faq.\n'
    + '> This file is a synced copy. Edit the canonical source and re-run\n'
    + '> `scripts/sync-license-faq.sh --docs-dir ../hdk-docs --native-dir ../lloyal.node --kernel-dir ../liblloyal`\n'
    + '> in hdk to update all copies.\n\n'
    + body.trimStart().replace(/\n*$/, '\n');
}

export function discoverFslPackages(hdkDir) {
  const root = JSON.parse(read(join(hdkDir, 'package.json')));
  if (!Array.isArray(root.workspaces) || root.workspaces.length === 0) {
    throw new Error('HDK package.json must declare its workspaces');
  }
  const rootLicense = read(join(hdkDir, 'LICENSE'));
  if (!rootLicense.startsWith(fslHeader)) throw new Error('HDK LICENSE is not the expected FSL license');
  const manifests = new Set();
  for (const workspace of root.workspaces) {
    const matches = globSync(`${workspace}/package.json`, { cwd: hdkDir });
    if (matches.length === 0) throw new Error(`Workspace has no package.json: ${workspace}`);
    for (const manifest of matches) manifests.add(manifest);
  }

  const packages = [];
  for (const relativeManifest of [...manifests].sort()) {
    const manifestPath = join(hdkDir, relativeManifest);
    const manifest = JSON.parse(read(manifestPath));
    const packageDir = dirname(manifestPath);
    const license = read(join(packageDir, 'LICENSE'));
    // The actual license, not a generic SEE LICENSE marker, defines scope.
    // Apache-licensed channel-verify and other independently licensed packages stay out.
    if (!license.startsWith(fslHeader)) continue;
    if (manifest.license !== 'SEE LICENSE IN LICENSE' && manifest.license !== 'FSL-1.1-Apache-2.0') {
      throw new Error(`${manifestPath} declares ${manifest.license} but contains an FSL LICENSE`);
    }
    if (license !== rootLicense) {
      throw new Error(`${packageDir}/LICENSE differs from HDK LICENSE; review it before synchronizing`);
    }
    for (const file of legalFiles) {
      if (!Array.isArray(manifest.files) || !manifest.files.includes(file)) {
        throw new Error(`${manifestPath} must include ${file} in its files array`);
      }
    }
    packages.push(packageDir);
  }
  if (packages.length === 0) throw new Error('No FSL workspaces found');
  return packages;
}

export function syncLicensing({ hdkDir = defaultHdkDir, docsDir, nativeDir, kernelDir, check = false } = {}) {
  hdkDir = resolve(hdkDir);
  const external = [docsDir, nativeDir, kernelDir];
  const fullSync = external.some(value => value !== undefined);
  if (fullSync && !external.every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('Cross-repository sync requires --docs-dir, --native-dir and --kernel-dir together');
  }
  const packageDirs = discoverFslPackages(hdkDir);
  const grant = read(join(hdkDir, 'GRANT.md'));
  if (!grant.trim()) throw new Error('Canonical GRANT.md is empty');
  let faq;
  const destinations = [...packageDirs];
  if (fullSync) {
    docsDir = resolve(docsDir);
    nativeDir = resolve(nativeDir);
    kernelDir = resolve(kernelDir);
    for (const directory of [docsDir, nativeDir, kernelDir]) requireDirectory(directory);
    if (new Set([hdkDir, docsDir, nativeDir, kernelDir]).size !== 4) {
      throw new Error('HDK, docs, native and kernel directories must be distinct');
    }
    for (const directory of [nativeDir, kernelDir]) {
      if (!read(join(directory, 'LICENSE')).startsWith(fslHeader)) {
        throw new Error(`${directory}/LICENSE is not the expected FSL license`);
      }
    }
    faq = renderFaq(read(join(docsDir, 'licensing', 'faq.md')));
    destinations.push(nativeDir, kernelDir);
  } else {
    faq = read(join(hdkDir, 'LICENSE-FAQ.md'));
    if (!faq.trim()) throw new Error('Checked-in LICENSE-FAQ.md is empty');
  }

  // Validate every target before any write, including missing external checkouts.
  const planned = destinations.flatMap(directory => [
    { path: join(directory, 'GRANT.md'), content: grant },
    { path: join(directory, 'LICENSE-FAQ.md'), content: faq },
  ]);
  if (fullSync) planned.push({ path: join(hdkDir, 'LICENSE-FAQ.md'), content: faq });
  const changed = planned.filter(({ path, content }) => {
    const existing = statSync(path, { throwIfNoEntry: false });
    if (!existing) return true;
    if (!existing.isFile()) throw new Error(`Sync target is not a regular file: ${path}`);
    return read(path) !== content;
  });
  if (check && changed.length > 0) {
    throw new Error(`Licensing copies are missing or out of date:\n${changed.map(file => `  ${file.path}`).join('\n')}\nRun npm run license:sync${fullSync ? ' with the same repository paths' : ''} and commit the updated copies.`);
  }
  if (!check) for (const { path, content } of changed) writeFileSync(path, content);
  return { checked: planned.length, changed: changed.length, packages: packageDirs.length };
}

function main(args) {
  const options = {};
  const flags = new Map([['--docs-dir', 'docsDir'], ['--native-dir', 'nativeDir'], ['--kernel-dir', 'kernelDir']]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--check') options.check = true;
    else if (flag === '--help') {
      console.log('Usage: node scripts/sync-licensing.mjs [--check] [--docs-dir PATH --native-dir PATH --kernel-dir PATH]\nSee scripts/LICENSING.md. No siblings or network are required for local sync/check.');
      return;
    } else if (flags.has(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[flags.get(flag)] = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  const result = syncLicensing(options);
  console.log(`${options.check ? 'Verified' : 'Synchronized'} ${result.checked} licensing copies across ${result.packages} FSL workspaces; ${result.changed} changed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
