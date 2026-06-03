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
#   ../liblloyal/LICENSE-FAQ.md                <- sync target
#   ../lloyal-node/LICENSE-FAQ.md              <- sync target
#   ./LICENSE-FAQ.md                           <- sync target (lloyal-sdk root)
#   ./packages/{agents,sdk,rig,apps/corpus,apps/web}/LICENSE-FAQ.md  <- sync targets
#
# packages/harness-cli/LICENSE-FAQ.md is NOT synced (that package is Apache 2.0,
# not FSL — see CONTRIBUTING for the cross-repo licensing policy).

set -euo pipefail

# Resolve paths relative to this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_DIR="$(cd "$SDK_DIR/.." && pwd)"

CANONICAL="$APPS_DIR/hdk-docs/licensing/faq.mdx"

if [[ ! -f "$CANONICAL" ]]; then
  echo "Error: canonical FAQ not found at $CANONICAL" >&2
  echo "Expected layout: hdk-docs/licensing/faq.mdx" >&2
  exit 1
fi

# Sync targets — in-repo LICENSE-FAQ.md files for every FSL surface.
# Note: liblloyal lives as a git submodule inside lloyal-node, not as a
# standalone repo. The standalone /Users/zuhairnaqvi/dev/apps/liblloyal/
# directory exists but has broken git internals and is not the canonical
# working tree. Always target the submodule path.
TARGETS=(
  "$APPS_DIR/lloyal-node/liblloyal/LICENSE-FAQ.md"
  "$APPS_DIR/lloyal-node/LICENSE-FAQ.md"
  "$SDK_DIR/LICENSE-FAQ.md"
  "$SDK_DIR/packages/agents/LICENSE-FAQ.md"
  "$SDK_DIR/packages/sdk/LICENSE-FAQ.md"
  "$SDK_DIR/packages/rig/LICENSE-FAQ.md"
  "$SDK_DIR/packages/apps/corpus/LICENSE-FAQ.md"
  "$SDK_DIR/packages/apps/web/LICENSE-FAQ.md"
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
  echo "> \`scripts/sync-license-faq.sh\` in lloyal-sdk to update all copies."
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
