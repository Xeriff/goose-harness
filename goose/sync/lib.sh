# shellcheck shell=bash disable=SC2034 # variables are read by the sourcing script
# Shared by sync.sh (the daily workflow) and resolve-noise.sh (by hand).
# Resolves merge noise that never needs a person: upstream workflows,
# pnpm lockfiles and generated files. Anything else is left conflicted.

# Space-separated globs treated as generated (mirrors .gitattributes).
# The web route tree is rebuilt after install (regenerate_routes) so our routes come back.
GENERATED_PATHS="${GENERATED_PATHS:-packages/source-control-github/schema/** apps/server/schema/** **/*.graphql.ts apps/web/src/routeTree.gen.ts}"
# Regenerates pnpm-lock.yaml without installing anything, with the pnpm
# version pinned in package.json so the lockfile format matches upstream.
LOCKFILE_REGEN_CMD="${LOCKFILE_REGEN_CMD:-npx --yes \"\$(jq -r .packageManager package.json)\" install --lockfile-only --ignore-scripts}"

AUTO_RESOLVED=()
REGEN_LOCKFILE=0

# Run during a merge (after `git merge`, before commit).
resolve_noise() {
  local f g generated globs
  read -ra globs <<<"$GENERATED_PATHS"

  # Upstream's CI needs their runners and secrets, so their workflows stay out
  # of our tree whether they conflicted or not. Our own files are goose-*.
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$(basename "$f")" in goose-*) continue ;; esac
    git rm -q -f --ignore-unmatch -- "$f"
    AUTO_RESOLVED+=("\`$f\`: upstream workflow, kept out of our tree")
  done < <({ git ls-files -- .github/workflows; git diff --name-only --diff-filter=U -- .github/workflows; } | sort -u)

  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if [[ "$(basename "$f")" == pnpm-lock.yaml ]]; then
      git checkout --theirs -- "$f" && git add -- "$f"
      REGEN_LOCKFILE=1
      AUTO_RESOLVED+=("\`$f\`: took upstream's lockfile and regenerated it")
      continue
    fi
    generated=0
    for g in "${globs[@]}"; do
      # shellcheck disable=SC2053 # glob match is intended
      if [[ "$f" == $g ]]; then generated=1; break; fi
    done
    # --theirs fails when upstream deleted the file; leave that for a person.
    if [[ "$generated" == 1 ]] && git checkout --theirs -- "$f" 2>/dev/null; then
      git add -- "$f"
      AUTO_RESOLVED+=("\`$f\`: generated file, took upstream's copy")
    fi
  done < <(git diff --name-only --diff-filter=U)
}

regenerate_lockfile() {
  bash -c "$LOCKFILE_REGEN_CMD" && git add -- pnpm-lock.yaml
}

# Needs installed dependencies. A text merge of the route tree can be clean and
# still wrong, so it is rebuilt from the merged route files on every sync.
ROUTES_REGEN_CMD="node goose/sync/gen-routes.mjs && git add -- apps/web/src/routeTree.gen.ts"
