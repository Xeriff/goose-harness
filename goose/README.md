# Goose Harness

Goose Harness is a private fork of [T3 Code](https://github.com/pingdotgg/t3code)
(MIT, © T3 Tools Inc., see [LICENSE](../LICENSE)) that tracks upstream's nightly
line and adds a plugin system. Upstream's own README is [README.md](../README.md).

What we add lives in our own files where it can, so the daily merge rarely
conflicts: this `goose/` folder, `plugins/`, `packages/goose-plugin-api`, the `goose/`
folders in `apps/server/src` and `apps/web/src`, `.github/README.md`, and
`.github/workflows/goose-*`. Edits to upstream files are kept to the few lines that
wire these in.

## Upstream sync

[`.github/workflows/goose-upstream-sync.yml`](../.github/workflows/goose-upstream-sync.yml)
runs every day at 04:17 UTC and on demand (Actions → Upstream sync → Run workflow).
It runs [`goose/sync/sync.sh`](sync/sync.sh), which:

1. Fetches `pingdotgg/t3code` `main` (the branch nightly builds come from) and mirrors its tags.
2. Merges it into our `main`. If `main` already contains it, it stops there.
3. Clears merge noise automatically, and lists each item in the merge commit or PR:
   - **Upstream workflows** are kept out of our tree. Upstream's CI needs their
     runners and secrets and would fail here on every schedule. Only our
     `goose-*` workflows run.
   - **`pnpm-lock.yaml`**: on conflict it takes upstream's lockfile and regenerates
     it against the merged `package.json` files.
   - **Generated files** (`*.graphql.ts`, `schema/`, the web route tree): on conflict it
     takes upstream's copy. The route tree is then rebuilt after install, so routes
     our plugins add come back.
4. If no other conflict is left, it commits the merge and runs install, build,
   typecheck and tests with upstream's own toolchain setup.
5. **All green:** pushes `main`. No approval needed.
6. **Conflict or failing check:** leaves `main` alone and opens a PR from
   `goose/upstream-sync` that says what conflicted or failed, which files are
   involved and which commits on each side touched them. If that PR is already
   open it is updated, never duplicated. Once you push commits to the branch,
   the sync stops force-pushing it and only updates the description.

A conflict in a real source file is never resolved automatically.

### Resolving a sync PR

**Conflict** (the PR shows upstream's tip and GitHub reports a conflict):

```sh
git fetch origin
git checkout main && git pull
git merge origin/goose/upstream-sync   # conflicts appear here
goose/sync/resolve-noise.sh            # clears workflows, lockfile, generated files
# resolve what it lists, read upstream's side before choosing, then:
git commit && git push origin main
```

Pushing the merge to `main` marks the PR as merged.

**Failed check** (the merge was clean; the PR holds the merge commit): push fixes
to `goose/upstream-sync`, then merge the PR with a merge commit (not squash).

If upstream fixes the problem itself, the next run merges cleanly, pushes `main`
and closes the PR.

### Setup

- Repository secret **`SYNC_TOKEN`**: a fine-grained personal access token for
  this repo with Contents, Pull requests and Workflows set to read and write.
  The default `GITHUB_TOKEN` can't push upstream commits that touch
  `.github/workflows`.
- Manual runs can set **dry run** (merge and check, push nothing) or **skip checks**.
- A full check run takes a while on a standard runner and counts against the
  account's private-repo Actions minutes. Days with no upstream change cost
  under a minute.

## Plugins

The server loads plugins at startup from `plugins/` in this repo, from
`<T3 home>/goose/plugins`, and from folders listed in `GOOSE_PLUGIN_DIRS`. Repo plugins can
also add a page, sidebar items, a settings panel and palette commands to the web and
desktop clients. Turn plugins on or off in Settings → Plugins; the change applies after a
server restart.

- [`plugins/my-work`](../plugins/my-work): Jira, Bitbucket and GitHub tasks with Start work.
- [Writing a plugin](plugins.md) covers the manifest, both APIs and the traps. Start from
  [`goose/plugin-template`](plugin-template).

The host lives in `apps/server/src/goose/` and `apps/web/src/goose/`, and the API in
[`packages/goose-plugin-api`](../packages/goose-plugin-api).
