#!/usr/bin/env bash
# Drive `oras` against a layout OUR code wrote, and our reader against a layout
# ORAS wrote. Nothing here asserts conformance by reading our own spec notes.
#
# Why a script and not a vitest case: the whole point is that none of our code
# is in the path. `oras` is the artifact-native tool, so if it can fetch, copy
# and re-lay-out what we write, the format claim holds independently of what we
# believe about it.
#
# The fixture is GENERATED with sharp rather than committed or borrowed: this
# repo has no image fixture, and the one the manual round-trip used lives in
# another repository that CI never checks out.
#
# `skopeo` is deliberately NOT run and is not owed: it is container-image
# tooling and is entitled to reject an artifact manifest whose config is not an
# image config.
set -euo pipefail

if ! command -v oras >/dev/null 2>&1; then
  echo "oras is not installed — this check cannot run."
  echo "  macOS: brew install oras     CI: see .github/workflows/ci.yml"
  exit 1
fi
echo "oras: $(oras version | head -1)"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

echo "── building ──"
( cd "$REPO" && npx tsc -b packages/media >/dev/null )

echo "── writing a layout through the REAL ingress (sharp → FileAttachmentStore) ──"
# A tall image, comfortably over the ceiling we pass, so the DERIVED branch runs
# and the manifest carries both a representation and a retained source — the
# two-layer case, which is the one with something to get wrong.
node -e "
  const sharp = require('sharp');
  const { createImageIngress, FileAttachmentStore } = require('$REPO/packages/media/dist/node.js');
  (async () => {
    const src = await sharp({ create: {
      width: 900, height: 600, channels: 3, background: { r: 30, g: 90, b: 160 },
    } }).jpeg({ quality: 92 }).toBuffer();
    const store = new FileAttachmentStore('$WORK/layout');
    const ingress = createImageIngress(store, { maxPixels: 65536 });
    const root = await ingress.ingest(new Uint8Array(src));
    require('fs').writeFileSync('$WORK/root.txt', root.digest);
    console.log('   root ' + root.digest.slice(0, 26) + '…  (source ' + src.length + ' B)');
  })().catch(e => { console.error(e); process.exit(1); });
"
ROOT="$(cat "$WORK/root.txt")"
LAYOUT="$WORK/layout"

# `:tag` after a shell variable MUST be braced. Unbraced, zsh reads `:c` as a
# history modifier and silently rewrites the path — which cost a false FAIL on
# the manual run and would mislead anyone re-running the proof by hand.
REF="${LAYOUT}:probe"

echo
echo "1. the layout has exactly the three entries image-layout.md requires"
test -f "$LAYOUT/oci-layout" || { echo "   FAILED: no oci-layout marker"; exit 1; }
test -f "$LAYOUT/index.json" || { echo "   FAILED: no index.json"; exit 1; }
test -d "$LAYOUT/blobs/sha256" || { echo "   FAILED: no blobs/sha256"; exit 1; }
# Every entry under blobs/<algorithm>/ must be named by its own encoded digest.
# A staging file left here would be a malformed entry a crash makes permanent.
# `ls`, not `find -printf`: the latter is GNU-only and silently degrades on
# macOS, where a developer re-running this proof by hand would get a check that
# passes without looking at anything.
BAD="$(ls "$LAYOUT/blobs/sha256")"
if echo "$BAD" | grep -qvE '^[0-9a-f]{64}$'; then
  echo "   FAILED: non-digest entry in blobs/sha256:"; echo "$BAD"; exit 1
fi
echo "   ok — oci-layout, index.json, blobs/sha256 with $(echo "$BAD" | wc -l | tr -d ' ') digest-named blobs"

echo "2. oras reads our manifest, with none of our code in the path"
if ! MAN="$(oras manifest fetch --oci-layout "${LAYOUT}@${ROOT}" 2>&1)"; then
  echo "   FAILED: oras cannot read the manifest we wrote."
  echo "           oras said: $MAN"
  exit 1
fi
echo "$MAN" | grep -q '"artifactType": *"application/vnd.lloyal.attachment.v1"' \
  || { echo "   FAILED: artifactType missing"; echo "$MAN"; exit 1; }
if ! LAYERS="$(echo "$MAN" | node -e "
  let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{
    const m = JSON.parse(s);
    if (m.schemaVersion !== 2) { console.error('schemaVersion is ' + m.schemaVersion + ', must be 2'); process.exit(1); }
    if (!Array.isArray(m.layers) || m.layers.length < 1) { console.error('layers must hold at least one descriptor'); process.exit(1); }
    const roles = m.layers.map(l => (l.annotations||{})['ai.lloyal.role']).join(',');
    if (roles !== 'representation,source') { console.error('layer roles are [' + roles + '], expected [representation,source] — replay reads the layers BY ROLE, so an untagged layer is a source it will feed the projector, or a representation it will skip'); process.exit(1); }
    console.log(m.layers.length + ' layers [' + roles + '], config ' + m.config.digest.slice(0,19) + '…');
  });
" 2>&1)"; then
  echo "   FAILED: the manifest oras read is not the shape we promise."
  echo "           $LAYERS"
  exit 1
fi
echo "   ok — $LAYERS"

echo "3. oras computes the SAME digest we recorded"
GOT="$(oras manifest fetch --oci-layout --descriptor "${LAYOUT}@${ROOT}" 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).digest))" || true)"
if [ "$GOT" != "$ROOT" ]; then
  echo "   FAILED: oras computes '$GOT' where we recorded '$ROOT'."
  echo "           The digest IS the identity — a trace referencing ours would be"
  echo "           unresolvable by any other tool."
  exit 1
fi
echo "   ok — ${GOT:0:26}…"

echo "4. the empty config blob EXISTS and is exactly {} — the conformance trap"
# A manifest that only NAMES the canonical empty config fails any puller, which
# fetches it like any other blob. This is the easy bug and the reason it is a
# separate check.
CFG="$(echo "$MAN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).config.digest))")"
if [ "$CFG" != 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' ]; then
  echo "   FAILED: config digest is '$CFG', not OCI's canonical empty descriptor."
  exit 1
fi
if ! BODY="$(oras blob fetch --oci-layout --output - "${LAYOUT}@${CFG}" 2>&1)"; then
  echo "   FAILED: the config blob is NAMED by the manifest but is not IN the layout."
  echo "           This is the easy conformance bug and the reason it gets its own"
  echo "           check: a puller fetches the config like any other blob, so a"
  echo "           manifest that only names the canonical empty descriptor fails"
  echo "           every puller while looking correct to us."
  echo "           oras said: $BODY"
  exit 1
fi
if [ "$BODY" != '{}' ]; then
  echo "   FAILED: the config blob is '$BODY', not {}"; exit 1
fi
echo "   ok — canonical empty config, fetched as {}"

echo "5. every layer blob retrieves by digest"
echo "$MAN" | node -e "
  let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>
    JSON.parse(s).layers.forEach(l => console.log(l.digest + ' ' + l.size)));
" | while read -r DIG SIZE; do
  N="$(oras blob fetch --oci-layout --output - "${LAYOUT}@${DIG}" 2>/dev/null | wc -c | tr -d ' ' || echo 0)"
  if [ "$N" != "$SIZE" ]; then
    echo "   FAILED: layer $DIG retrieves $N bytes, the manifest declares $SIZE."
    echo "           A size that disagrees with the blob breaks any puller that"
    echo "           preallocates, and replay would rebuild different pixels."
    exit 1
  fi
done
echo "   ok — all layers retrieve at their declared size"

echo "6. oras cp preserves the digest into a layout it lays out ITSELF"
if ! CP="$(oras cp --from-oci-layout --to-oci-layout "${LAYOUT}@${ROOT}" "${WORK}/copy:probe" 2>&1)"; then
  echo "   FAILED: oras could not copy our layout."
  echo "           $CP"
  exit 1
fi
test -f "$WORK/copy/oci-layout" || { echo "   FAILED: oras wrote no oci-layout"; exit 1; }
CPD="$(oras manifest fetch --oci-layout --descriptor "$WORK/copy@${ROOT}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).digest))")"
[ "$CPD" = "$ROOT" ] || { echo "   FAILED: digest changed on copy"; exit 1; }
echo "   ok — oras-written layout, digest preserved end to end"

echo "7. OUR reader on the ORAS-written layout — the exact call replay makes"
node -e "
  const { FileAttachmentStore } = require('$REPO/packages/media/dist/node.js');
  const { materialize } = require('$REPO/packages/media/dist/index.js');
  const store = new FileAttachmentStore('$WORK/copy');
  const manifest = store.getManifest('$ROOT');
  if (!manifest) throw new Error('our reader could not read the oras-written manifest');
  const out = materialize(store, [{ digest: '$ROOT', mediaType: manifest.mediaType, size: 0 }]);
  if (out.bitmaps.length !== 1) throw new Error('expected one representation, got ' + out.bitmaps.length);
  if (out.bitmaps[0].byteLength === 0) throw new Error('materialized an empty bitmap');
  console.log('   ok — materialize() rebuilt ' + out.bitmaps[0].byteLength + ' B from a layout oras wrote');
"

echo
echo "OCI CONFORMANCE VERIFIED"
