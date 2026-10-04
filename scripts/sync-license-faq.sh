#!/usr/bin/env bash
#
# sync-license-faq.sh
#
# Copies the canonical licensing FAQ from hdk-docs to each FSL repo in the
# lloyal runtime stack. The hdk-docs version (hdk-docs/licensing/faq.mdx) is
# the source of truth; the in-repo LICENSE-FAQ.md files are sync targets so
# the explainer is at the point of contact for anyone reading a GitHub repo
# or an installed npm package.
#
# Strips Mintlify frontmatter from .mdx so the output is plain .md.
#
# Usage:
#   ./scripts/sync-license-faq.sh
#
# Assumes the following directory layout (same as the working monorepo):
#   ../hdk-docs/licensing/faq.mdx              <- canonical source
#   ../lloyal-node/liblloyal/LICENSE-FAQ.md     <- sync target (submodule)
#   ../lloyal-node/LICENSE-FAQ.md              <- sync target
#   ./LICENSE-FAQ.md                           <- sync target (HDK root)
#   ./packages/*/LICENSE-FAQ.md                <- existing FSL package copies
#   ./packages/abilities/*/LICENSE-FAQ.md      <- existing FSL ability copies
#
# Only the FSL package FAQ copies listed below are synced.

set -euo pipefail

# Resolve paths relative to this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_DIR="$(cd "$HDK_DIR/.." && pwd)"

CANONICAL="$APPS_DIR/hdk-docs/licensing/faq.mdx"

if [[ ! -f "$CANONICAL" ]]; then
  echo "Error: canonical FAQ not found at $CANONICAL" >&2
  echo "Expected layout: hdk-docs/licensing/faq.mdx" >&2
  exit 1
fi

# Sync targets — in-repo LICENSE-FAQ.md files for every FSL surface.
# liblloyal is checked out as a git submodule inside the sibling lloyal-node
# working tree; sync that copy along with the binding's root FAQ.
TARGETS=(
  "$APPS_DIR/lloyal-node/liblloyal/LICENSE-FAQ.md"
  "$APPS_DIR/lloyal-node/LICENSE-FAQ.md"
  "$HDK_DIR/LICENSE-FAQ.md"
  "$HDK_DIR/packages/agents/LICENSE-FAQ.md"
  "$HDK_DIR/packages/sdk/LICENSE-FAQ.md"
  "$HDK_DIR/packages/rig/LICENSE-FAQ.md"
  "$HDK_DIR/packages/binding/LICENSE-FAQ.md"
  "$HDK_DIR/packages/host/LICENSE-FAQ.md"
  "$HDK_DIR/packages/media/LICENSE-FAQ.md"
  "$HDK_DIR/packages/relay/LICENSE-FAQ.md"
  "$HDK_DIR/packages/abilities/corpus/LICENSE-FAQ.md"
  "$HDK_DIR/packages/abilities/documents/LICENSE-FAQ.md"
  "$HDK_DIR/packages/abilities/web/LICENSE-FAQ.md"
)

# Convert .mdx to .md by stripping leading frontmatter block (--- ... ---).
# awk skips lines until the second --- delimiter, then emits everything after.
strip_frontmatter() {
  awk '
    BEGIN { in_fm = 0; passed = 0 }
    !passed && /^---$/ {
      if (in_fm == 0) { in_fm = 1; next }
      else { passed = 1; next }
    }
    passed { print }
    !passed && in_fm == 0 { print }   # no frontmatter at all
  ' "$1"
}

PLAIN_FAQ="$(mktemp)"
trap 'rm -f "$PLAIN_FAQ"' EXIT

# Prepend a header so the file makes sense standalone (without the Mintlify
# frontmatter that would have rendered the title in hdk-docs).
{
  echo "# Licensing FAQ"
  echo ""
  echo "> Canonical version at https://docs.lloyal.ai/licensing/faq."
  echo "> This file is a synced copy. Edit the canonical source and re-run"
  echo "> \`scripts/sync-license-faq.sh\` in hdk to update all copies."
  echo ""
  strip_frontmatter "$CANONICAL"
} > "$PLAIN_FAQ"

# Copy to each target.
for target in "${TARGETS[@]}"; do
  target_dir="$(dirname "$target")"
  if [[ ! -d "$target_dir" ]]; then
    echo "Warning: skipping $target — directory does not exist" >&2
    continue
  fi
  cp "$PLAIN_FAQ" "$target"
  echo "  synced -> $target"
done

echo "Done. $(echo "${TARGETS[@]}" | wc -w | tr -d ' ') target paths processed."
