#!/usr/bin/env bash
# Run the OCI distribution-spec conformance suite's blob push group against the
# upload surface a harness host mounts (`createContentRoutes` with
# `BlobUploads`), over a scratch store. None of our code is in the client path:
# the suite is the registry ecosystem's own test.
#
# Scope, declared to the suite rather than hidden from it:
#   - the surface runs as a full registry (`registry: true`): the suite pushes
#     arbitrary blobs and reads them back by digest, where a harness host admits
#     only video originals and serves their bytes only through the attachment;
#   - blob delete is off: the store deletes nothing on its own;
#   - manifests are never pushed: the host composes them;
#   - sha512 is off: the store addresses sha256 only.
#
# Needs Docker. The suite image is built from a pinned commit of
# opencontainers/distribution-spec, so a run is reproducible.
set -euo pipefail

SUITE_COMMIT=47caa1429f4d4e60e3f8023871c1b28538b1b1c6
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${OCI_PORT:-5055}"
HOST_PID=""
cleanup() { [ -n "$HOST_PID" ] && kill "$HOST_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "Docker is not available — this check cannot run."; exit 1; }

echo "── building the suite at ${SUITE_COMMIT:0:12} ──"
curl -sfL "https://codeload.github.com/opencontainers/distribution-spec/tar.gz/${SUITE_COMMIT}" | tar -xz -C "$WORK"
docker build -q -t lloyal/oci-conformance:"${SUITE_COMMIT:0:12}" "$WORK/distribution-spec-${SUITE_COMMIT}/conformance" >/dev/null

echo "── building the host routes ──"
( cd "$REPO" && npx tsc -b packages/media packages/rig >/dev/null )

echo "── serving the upload surface on :$PORT ──"
node -e "
  const { createServer } = require('node:http');
  const { FileAttachmentStore } = require('$REPO/packages/media/dist/node.js');
  const { createContentRoutes, BlobUploads } = require('$REPO/packages/rig/dist/node.js');
  const store = new FileAttachmentStore('$WORK/store');
  const routes = createContentRoutes({ store, uploads: new BlobUploads(store, store, { registry: true }) });
  createServer((req, res) => { if (!routes(req, res)) { res.writeHead(404); res.end(); } }).listen($PORT, '0.0.0.0');
" &
HOST_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v2/" >/dev/null && break; sleep 0.1; done

# Linux runs the suite on the host network; Docker Desktop reaches the host by name.
if [ "$(uname)" = "Linux" ]; then NET=(--net=host); REGISTRY="127.0.0.1:$PORT"; else NET=(); REGISTRY="host.docker.internal:$PORT"; fi

echo "── running the sha256 blob group ──"
docker run --rm ${NET[@]+"${NET[@]}"} -v "$WORK:/results" \
  -e OCI_REGISTRY="$REGISTRY" -e OCI_TLS=disabled \
  -e OCI_REPO1=lloyal/conformance1 -e OCI_REPO2=lloyal/conformance2 \
  -e OCI_API_PULL=true -e OCI_API_BLOBS_DELETE=false -e OCI_API_MANIFESTS_DELETE=false \
  -e OCI_API_TAGS_DELETE=false -e OCI_API_TAGS_LIST=false -e OCI_API_REFERRER=false \
  -e OCI_API_BLOBS_UPLOAD_CANCEL=true -e OCI_API_BLOBS_DIGEST_HEADER=true \
  -e OCI_DATA_SHA512=false -e OCI_DATA_EMPTY_BLOB=true \
  -e OCI_FILTER_TEST="OCI Conformance Test/sha256 blobs" \
  -e OCI_RESULTS_DIR=/results \
  lloyal/oci-conformance:"${SUITE_COMMIT:0:12}" 2>&1 | tee "$WORK/suite.log" | grep -vE '^time=.*level=(DEBUG|INFO)' || true

# The suite's own exit status does not reflect failed tests; its summary does.
if grep -q 'OCI Conformance Test: FAIL' "$WORK/suite.log" || ! grep -qE 'FAIL\.+: +0$' "$WORK/suite.log"; then
  echo; echo "DISTRIBUTION CONFORMANCE FAILED"; exit 1
fi
echo
echo "DISTRIBUTION CONFORMANCE (blob push and pull) VERIFIED"
