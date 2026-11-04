#!/usr/bin/env bash
# Run in the middle of a conflicted upstream merge to clear the noise the daily
# sync clears automatically (upstream workflows, lockfile, generated files).
# Prints the conflicts that are left for you to resolve by hand.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=goose/sync/lib.sh
source goose/sync/lib.sh

git rev-parse -q --verify MERGE_HEAD >/dev/null || { echo "No merge in progress." >&2; exit 1; }
resolve_noise
[[ "$REGEN_LOCKFILE" == 1 ]] && regenerate_lockfile
if [[ -d node_modules ]]; then
  bash -c "$ROUTES_REGEN_CMD" && echo "regenerated: apps/web/src/routeTree.gen.ts"
else
  echo "Run vp install, then: $ROUTES_REGEN_CMD"
fi
for r in "${AUTO_RESOLVED[@]}"; do echo "resolved: ${r//\`/}"; done
left="$(git diff --name-only --diff-filter=U)"
if [[ -n "$left" ]]; then
  echo "Still conflicted (resolve these yourself):"
  while IFS= read -r f; do echo "  $f"; done <<<"$left"
else
  echo "No conflicts left. Review, then: git commit"
fi
