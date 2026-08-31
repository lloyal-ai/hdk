#!/usr/bin/env bash
# Prove @lloyal-labs/media works FROM ITS PUBLISHED ARTIFACT, not the worktree.
#
# The three claims below cannot be checked any other way. A workspace test
# resolves through symlinks to `src`/`dist` and will pass no matter what the
# manifest declares — which is exactly how `sharp` sat in `devDependencies`
# (never installed for consumers) while the README promised it was a peer
# concern, leaving every published `normalizeImage` call throwing.
#
# It also independently catches the stale-neighbour hazard this repo has hit
# six times: a packed install has no symlinks, so a package that silently
# resolved a REGISTRY copy of its neighbour fails here and nowhere else.
#
#   1. the browser-safe `.` entry imports with NO sharp present, and reaches
#      neither sharp nor `node:` — STRUCTURALLY, by what it requires
#   2. the manifest tells a consumer that sharp is an optional peer
#   3. `./node` normalizes from the packed build once sharp is added
#
# Claim 1 reads the packed `dist/index.js`'s own requires rather than trusting
# that the import succeeded: in Node it would succeed either way. The `.`/`./node`
# split is what makes that check meaningful — before it, purity rested on a
# call-time `require` that any future static import would have silently undone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAT="${CAT_FIXTURE:-$HOME/dev/apps/lloyal-node/liblloyal/tests/fixtures/cat.jpg}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "workdir: $WORK"

echo "── building ──"
( cd "$REPO" && npx tsc -b packages/media >/dev/null )

# media has NO internal dependencies — that is the point of the phase-8 layout,
# and packing it alone is what proves it. A missing neighbour would fail the
# install here rather than resolving through a workspace symlink.
echo "── packing media alone (it is a dependency root) ──"
mkdir -p "$WORK/tars"
( cd "$REPO/packages/media" && npm pack --pack-destination "$WORK/tars" --silent >/dev/null )
ls "$WORK/tars"

echo "── clean consumer, NO sharp ──"
mkdir -p "$WORK/consumer" && cd "$WORK/consumer"
cat > package.json <<'JSON'
{ "name": "packed-consumer", "version": "1.0.0", "private": true }
JSON
npm install --silent --no-audit --no-fund "$WORK"/tars/*.tgz

echo
echo "1. the '.' entry is browser-safe: no sharp, no node:, no internal deps"
node -e "
  const m = require('@lloyal-labs/media');
  if (typeof m.sniffMediaType !== 'function') throw new Error('root entry did not load');
  if (typeof m.NullAttachmentStore !== 'function') throw new Error('root entry is incomplete');
  try { require.resolve('sharp'); throw new Error('sharp IS installed — this case proves nothing'); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

  // Structural, not incidental: walk what the packed root actually requires.
  const fs = require('fs'), path = require('path');
  const dir = path.dirname(require.resolve('@lloyal-labs/media'));
  const seen = new Set();
  (function walk(file) {
    if (seen.has(file)) return; seen.add(file);
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/require\\([\"']([^\"']+)[\"']\\)/g)) {
      if (spec.startsWith('node:') || spec === 'sharp' || spec.startsWith('@lloyal-labs/')) {
        throw new Error(path.basename(file) + ' reaches ' + spec + ' — the root entry is not browser-safe');
      }
      if (spec.startsWith('.')) walk(require.resolve(path.resolve(path.dirname(file), spec)));
    }
  })(require.resolve('@lloyal-labs/media'));
  console.log('   ok — ' + seen.size + ' modules, none reaching sharp, node: or a sibling package');
"

echo "2. the manifest declares sharp as an OPTIONAL PEER"
node -e "
  const p = JSON.parse(require('fs').readFileSync('node_modules/@lloyal-labs/media/package.json', 'utf8'));
  const peer = (p.peerDependencies||{}).sharp;
  const opt  = ((p.peerDependenciesMeta||{}).sharp||{}).optional;
  if (!peer) throw new Error('sharp is not a peerDependency — a consumer cannot discover it');
  if (opt !== true) throw new Error('sharp peer is not marked optional');
  if ((p.devDependencies||{}).sharp && !peer) throw new Error('devDependency only: never installed for consumers');
  if (!(p.files||[]).includes('README.md')) throw new Error('README.md missing from files — the format spec never ships');
  console.log('   ok — peer '+peer+', optional, README packaged');
"

echo "3. './node' normalizes from the packed build once sharp is installed"
npm install --silent --no-audit --no-fund sharp@^0.35.4
node -e "
  const { normalizeImage, FileAttachmentStore } = require('@lloyal-labs/media/node');
  if (typeof FileAttachmentStore !== 'function') throw new Error('the node entry is incomplete');
  const fs = require('fs');
  const src = new Uint8Array(fs.readFileSync('$CAT'));
  normalizeImage(src, { maxPixels: 65536 }).then(o => {
    if (!o.derived) throw new Error('expected a derivation at this ceiling');
    if (!(o.bytes.byteLength < src.byteLength)) throw new Error('no reduction');
    console.log('   ok — '+src.byteLength+' B -> '+o.bytes.byteLength+' B, '+o.width+'x'+o.height);
  }).catch(e => { console.error('   FAILED: '+e.message); process.exit(1); });
"
echo
echo "PACKED INSTALL VERIFIED"
