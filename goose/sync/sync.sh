#!/usr/bin/env bash
# Daily upstream sync for Goose Harness.
#
# Merges upstream T3 Code (pingdotgg/t3code, branch main = nightly) into our
# main branch. A clean merge whose install, build and tests pass is pushed to
# main. A conflict or a failing check opens (or updates) one pull request from
# the sync branch instead, explaining what went wrong.
#
# Noise that is resolved automatically, and always listed in the commit/PR:
#   - Upstream GitHub Actions workflows. We do not run upstream's CI (it needs
#     their runners and secrets), so every .github/workflows file except our
#     own goose-* files is kept out of our tree.
#   - pnpm lockfiles. On conflict we take upstream's lockfile and regenerate it
#     against the merged package.json files.
#   - Generated files listed in GENERATED_PATHS. On conflict we take upstream's
#     copy; these are regenerated from upstream sources anyway.
# Any other conflict is a real conflict and is never resolved silently.
#
# Run from the repository root with a clean working tree checked out at
# TARGET_BRANCH. See goose/README.md for the full description.
set -euo pipefail
# shellcheck source=goose/sync/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
SYNC_BRANCH="${SYNC_BRANCH:-goose/upstream-sync}"
# Checks run on the merge result, in order; the first failure stops. Set one
# to an empty string to skip it.
SYNC_INSTALL_CMD="${SYNC_INSTALL_CMD-vp install}"
SYNC_BUILD_CMD="${SYNC_BUILD_CMD-vp run build}"
SYNC_TEST_CMD="${SYNC_TEST_CMD-vp run typecheck && vp run test}"
# DRY_RUN=1 does everything except push and touch pull requests.
DRY_RUN="${DRY_RUN:-0}"
BOT_EMAIL="${BOT_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
BOT_NAME="${BOT_NAME:-github-actions[bot]}"

WORK="${RUNNER_TEMP:-$(mktemp -d)}/goose-sync"
mkdir -p "$WORK"
REPORT="$WORK/report.md"
: >"$REPORT"
FAILED_STEP=""

log() { printf '::notice::%s\n' "$*" >&2; }
out() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; return 0; }
summary() { [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && cat "$1" >>"$GITHUB_STEP_SUMMARY"; return 0; }

git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi
git fetch --no-tags --quiet upstream "+refs/heads/$UPSTREAM_BRANCH:refs/remotes/upstream/$UPSTREAM_BRANCH"
git fetch --no-tags --quiet origin "+refs/heads/$TARGET_BRANCH:refs/remotes/origin/$TARGET_BRANCH"
git fetch --no-tags --quiet origin "+refs/heads/$SYNC_BRANCH:refs/remotes/origin/$SYNC_BRANCH" 2>/dev/null || true

# Mirror upstream's release and nightly tags. Not fatal: a tag upstream moved
# (rare) is left as it is and reported.
if [[ "$DRY_RUN" != 1 ]]; then
  git fetch --quiet upstream 'refs/tags/*:refs/tags/*' 2>"$WORK/tags.log" || true
  if ! git push --quiet origin --tags 2>>"$WORK/tags.log"; then
    printf '::warning::Some upstream tags could not be pushed:\n%s\n' "$(tail -n 20 "$WORK/tags.log")" >&2
  fi
fi

UP_SHA="$(git rev-parse "upstream/$UPSTREAM_BRANCH")"
BASE_SHA="$(git rev-parse "origin/$TARGET_BRANCH")"
git checkout --quiet -B "$TARGET_BRANCH" "$BASE_SHA"
PREV_UP="$(git merge-base "$BASE_SHA" "$UP_SHA" || true)"
UP_SHORT="$(git rev-parse --short "$UP_SHA")"
NEW_COMMITS="$(git rev-list --count "$BASE_SHA..$UP_SHA")"
out upstream_sha "$UP_SHA"

# --- Pull request helpers ---------------------------------------------------

open_pr_number() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  gh pr list --state open --head "$SYNC_BRANCH" --base "$TARGET_BRANCH" --json number --jq '.[0].number // empty'
}

close_stale_pr() {
  local reason="$1" pr
  pr="$(open_pr_number)"
  [[ -z "$pr" ]] && return 0
  log "Closing sync PR #$pr: $reason"
  gh pr close "$pr" --comment "$reason"$'\n\n_Closed automatically by the upstream sync._'
  # Keep the branch if a person committed to it, so no work is lost.
  if ! sync_branch_has_human_commits; then
    git push --quiet origin --delete "$SYNC_BRANCH" || true
  fi
}

# True when the sync branch has commits that the bot did not write, i.e. a
# person has started resolving it. We never force-push over their work.
sync_branch_has_human_commits() {
  git rev-parse --verify --quiet "refs/remotes/origin/$SYNC_BRANCH" >/dev/null || return 1
  local authors
  authors="$(git log --format='%ce' "refs/remotes/origin/$SYNC_BRANCH" --not "$BASE_SHA" "$UP_SHA" | sort -u)"
  [[ -n "$authors" && "$authors" != "$BOT_EMAIL" ]]
}

# --- Up to date --------------------------------------------------------------

if git merge-base --is-ancestor "$UP_SHA" "$BASE_SHA"; then
  log "Already contains upstream $UP_SHORT. Nothing to do."
  out result up-to-date
  # A sync PR left open (e.g. a person merged upstream by hand) is now stale.
  close_stale_pr "\`$TARGET_BRANCH\` already contains upstream \`$UP_SHORT\`, so this sync PR is no longer needed."
  exit 0
fi

log "Merging $NEW_COMMITS upstream commits up to $UP_SHORT into $TARGET_BRANCH"

# --- Merge and resolve noise -------------------------------------------------

MERGE_MSG="Merge upstream T3 Code ($UP_SHORT) into $TARGET_BRANCH"
git merge --no-ff --no-commit --no-edit "$UP_SHA" >"$WORK/merge.log" 2>&1 || true

resolve_noise
REAL_CONFLICTS=()
while IFS= read -r f; do [[ -n "$f" ]] && REAL_CONFLICTS+=("$f"); done < <(git diff --name-only --diff-filter=U)

if [[ "$REGEN_LOCKFILE" == 1 && ${#REAL_CONFLICTS[@]} -eq 0 ]]; then
  log "Regenerating pnpm-lock.yaml"
  if regenerate_lockfile >"$WORK/lockfile.log" 2>&1; then
    :
  else
    FAILED_STEP="regenerate lockfile"
    cp "$WORK/lockfile.log" "$WORK/failed.log"
  fi
fi

# --- Checks -----------------------------------------------------------------

run_step() {
  local name="$1" cmd="$2"
  [[ -n "$FAILED_STEP" || -z "$cmd" ]] && return 0
  log "Running $name: $cmd"
  echo "::group::$name"
  if bash -c "$cmd" 2>&1 | tee "$WORK/$name.log"; then
    echo "::endgroup::"
  else
    echo "::endgroup::"
    FAILED_STEP="$name"
    cp "$WORK/$name.log" "$WORK/failed.log"
  fi
}

if [[ ${#REAL_CONFLICTS[@]} -gt 0 ]]; then
  RESULT=conflict
  git merge --abort
else
  {
    echo "$MERGE_MSG"
    echo
    echo "Upstream: $UPSTREAM_URL $UPSTREAM_BRANCH @ $UP_SHA ($NEW_COMMITS new commits)."
    if [[ ${#AUTO_RESOLVED[@]} -gt 0 ]]; then
      echo
      echo "Resolved automatically by goose/sync/sync.sh:"
      printf -- '- %s\n' "${AUTO_RESOLVED[@]}" | tr -d '`'
    fi
  } >"$WORK/commit-msg"
  git commit --quiet --no-verify -F "$WORK/commit-msg"
  MERGE_SHA="$(git rev-parse HEAD)"
  run_step install "$SYNC_INSTALL_CMD"
  run_step build "$SYNC_BUILD_CMD"
  run_step test "$SYNC_TEST_CMD"
  # Checks must not leave edits behind (e.g. an install rewriting the lockfile).
  if [[ -z "$FAILED_STEP" ]] && [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    FAILED_STEP="clean tree after checks"
    git status --short --untracked-files=no >"$WORK/failed.log"
  fi
  RESULT=$([[ -z "$FAILED_STEP" ]] && echo pass || echo checks-failed)
  git reset --quiet --hard "$MERGE_SHA"
fi
out result "$RESULT"

# --- Clean and green: push to main ---------------------------------------------

if [[ "$RESULT" == pass ]]; then
  log "Clean merge and checks passed. Pushing $TARGET_BRANCH."
  if [[ "$DRY_RUN" != 1 ]]; then
    git push --force-with-lease="$TARGET_BRANCH:$BASE_SHA" origin "HEAD:refs/heads/$TARGET_BRANCH"
    close_stale_pr "Upstream \`$UP_SHORT\` merged cleanly and passed checks, so \`$TARGET_BRANCH\` was updated directly and this sync PR is no longer needed."
  fi
  {
    echo "## Upstream sync: merged"
    echo
    echo "Merged $NEW_COMMITS upstream commits up to \`$UP_SHORT\` into \`$TARGET_BRANCH\`."
  } >"$REPORT"
  summary "$REPORT"
  exit 0
fi

# --- Conflict or failing check: open or update the sync PR -------------------

if [[ "$RESULT" == conflict ]]; then
  SYNC_HEAD="$UP_SHA"     # the PR shows upstream; GitHub shows the conflict
  TITLE="Upstream sync: merge conflict with T3 Code $UP_SHORT"
else
  SYNC_HEAD="$MERGE_SHA"  # the PR holds the merge so fixes go on top of it
  TITLE="Upstream sync: $FAILED_STEP failed after merging T3 Code $UP_SHORT"
fi

{
  echo "This PR was opened by the daily upstream sync because \`$TARGET_BRANCH\` could not be updated automatically."
  echo
  echo "- Upstream: \`pingdotgg/t3code@$UPSTREAM_BRANCH\` at [\`$UP_SHORT\`](https://github.com/pingdotgg/t3code/commit/$UP_SHA)"
  echo "- Our \`$TARGET_BRANCH\`: \`$(git rev-parse --short "$BASE_SHA")\`, last synced upstream \`$(git rev-parse --short "${PREV_UP:-$BASE_SHA}")\`"
  echo "- New upstream commits: $NEW_COMMITS"
  echo
  if [[ "$RESULT" == conflict ]]; then
    echo "## Merge conflicts"
    echo
    echo "These files changed on both sides and need a person to resolve them:"
    echo
    for f in "${REAL_CONFLICTS[@]}"; do
      echo "### \`$f\`"
      echo
      echo "Upstream commits touching it:"
      echo
      echo '```'
      git log --oneline --no-merges -n 10 "$BASE_SHA..$UP_SHA" -- "$f" || true
      echo '```'
      echo "Our commits touching it:"
      echo
      echo '```'
      git log --oneline --no-merges -n 10 "$UP_SHA..$BASE_SHA" -- "$f" || true
      echo '```'
      echo
    done
  else
    echo "## Failed check: $FAILED_STEP"
    echo
    echo "The merge itself was clean, but \`$FAILED_STEP\` failed. Last 80 lines of output:"
    echo
    echo '```'
    tail -n 80 "$WORK/failed.log" | cut -c1-300
    echo '```'
    echo
    echo "Full logs are in the [workflow run](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-})."
    echo
    echo "Files changed by upstream in this sync that our fork also changes:"
    echo
    echo '```'
    comm -12 <(git diff --name-only "$PREV_UP" "$UP_SHA" | sort) <(git diff --name-only "$PREV_UP" "$BASE_SHA" | sort) | head -50 || true
    echo '```'
  fi
  if [[ ${#AUTO_RESOLVED[@]} -gt 0 ]]; then
    echo
    echo "## Resolved automatically"
    echo
    printf -- '- %s\n' "${AUTO_RESOLVED[@]}"
  fi
  echo
  echo "## How to resolve"
  echo
  if [[ "$RESULT" == conflict ]]; then
    echo '```sh'
    echo "git fetch origin"
    echo "git checkout $TARGET_BRANCH && git pull"
    echo "git merge origin/$SYNC_BRANCH        # conflicts appear here"
    echo "goose/sync/resolve-noise.sh           # drops upstream workflows, fixes the lockfile"
    echo "# resolve the remaining files, then:"
    echo "git commit && git push origin $TARGET_BRANCH"
    echo '```'
    echo
    echo "Pushing the merge to \`$TARGET_BRANCH\` marks this PR as merged. Never resolve a conflict by dropping upstream's side of a source file without reading it."
  else
    echo "Push fixes to \`$SYNC_BRANCH\` and merge this PR (use a merge commit, not squash, so upstream history is kept). Once the branch has your commits the sync stops force-pushing it and only updates this description."
  fi
  echo
  echo "_Updated by the upstream sync on $(date -u +%Y-%m-%dT%H:%MZ)._"
} >"$REPORT"
summary "$REPORT"

if [[ "$DRY_RUN" == 1 ]]; then
  log "DRY_RUN: would push $SYNC_HEAD to $SYNC_BRANCH and open/update the PR"
  cat "$REPORT"
  exit 0
fi

PR="$(open_pr_number)"
if sync_branch_has_human_commits; then
  log "$SYNC_BRANCH has commits from a person; not force-pushing it."
  {
    echo
    echo "> **Note:** upstream has moved to \`$UP_SHORT\`, but \`$SYNC_BRANCH\` was not updated because it already has your commits. Merge \`upstream/$UPSTREAM_BRANCH\` into it yourself if you need the newer upstream."
  } >>"$REPORT"
else
  git push --force origin "$SYNC_HEAD:refs/heads/$SYNC_BRANCH"
fi

if [[ -n "$PR" ]]; then
  gh pr edit "$PR" --title "$TITLE" --body-file "$REPORT"
  log "Updated sync PR #$PR"
else
  gh pr create --base "$TARGET_BRANCH" --head "$SYNC_BRANCH" --title "$TITLE" --body-file "$REPORT"
fi
# The run itself succeeded at its job (reporting); a red run would only add noise.
exit 0
