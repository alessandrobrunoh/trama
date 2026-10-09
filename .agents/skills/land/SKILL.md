---
name: land
description: >-
  Land the current changes in the trama repository (github.com/alessandrobrunoh/trama)
  by committing them, opening a pull request against main, and merging that pull
  request with a merge commit after the applicable checks pass. Invoke this skill
  only when the user has explicitly requested landing, such as the Land Changes
  action or /land. Do not invoke it for review, preparation, passing checks, or
  skill installation.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Land changes in trama

Landing means the requested change is on `origin/main` via a merged pull request. Pushing a branch, opening a pull request, or starting checks is not completion. If a blocker stops the workflow, say that the changes have not landed and name the blocker.

An explicit landing request (Land Changes or `/land`) is the instruction to carry out this workflow. Do not ask again whether to merge. Do not answer `/land` by saying you are waiting for an explicit landing request. Stop only for a real blocker: unrelated work, ambiguous scope, a conflict, a failing or unverifiable check, or a merge that would overwrite work that is not part of this landing.

Use `gh` against `origin` (`https://github.com/alessandrobrunoh/trama.git`). The default branch is `main`. Do not push directly to `main`. Do not force-push. Do not squash or rebase. Do not delete the remote head branch (`delete_branch_on_merge` is off). Commands that might open an editor must be non-interactive: pass the message or body on the command line, and prefix any Git command that might still open an editor with `GIT_EDITOR=true`.

## 1. See what is being landed

Inspect status, the diff against `origin/main`, and whether a pull request already exists for the current branch:

```bash
git fetch origin main
git status --short
git diff origin/main...HEAD
git diff
gh pr view --json number,state,url,headRefOid,baseRefName
```

Land only the change the user asked to land. If the worktree also contains unrelated uncommitted or unpushed work, stop. Do not commit secrets (`.env` files, tokens, keys, credentials).

## 2. Put the change on a branch and commit it

If the change is already committed on a non-`main` branch, keep that branch. Otherwise create a short descriptive branch from the current `HEAD` (for example `docs/landing-skill` or `fix/workspace-isolation`) and commit there. Do not commit on `main`.

Commit messages are short and imperative. There is no conventional-commits requirement. Examples: `Add workstream repository relation`, `Fix workspace scoping in execution query`.

```bash
git switch -c <branch>
GIT_EDITOR=true git commit -m "<imperative summary>"
```

If the hook fails, or the branch cannot be created without mixing in unrelated commits, stop. The changes have not landed.

## 3. Verify locally, in proportion to the diff

Run a command only when the diff touches that area. Skipping a command because the diff does not touch its area is success for that command, not a missing check. Do not run the root `npm run typecheck`, `npm run lint`, or `npm test` commands listed in `CONTRIBUTING.md`: the root `package.json` defines no `typecheck` or `lint` script, and `angular.json` defines no `test` target, so `npm test` (`ng test`) is not a usable check.

- Frontend (`src/`, `public/`, `angular.json`, root `package.json`, or other files the root Angular build compiles): `npm run build`. This is `ng build` (`package.json` script `build`; `angular.json` target `delta:build`).
- API (`server/`): from `server/`, `npm test`, then `npm run lint`, then `npm run build`. Those are `vitest run`, `oxlint --type-aware src/ test/`, and `nest build` (`server/package.json`). Do not run `npm run test:e2e` unless the change is specifically to the end-to-end suite; that command recreates the `trama_core_test` database.
- CLI, MCP sources, or the CLI skill (`cli/`, `mcp/src/`, `skills/trama-cli/`): from `cli/`, `cargo test --locked` and `cargo build --locked` (`.github/workflows/cli-ci.yml`).

If a command you did run fails, stop. Do not weaken or disable the check. The changes have not landed.

## 4. Publish and open the pull request

Push the branch and open one pull request against `main`. If a pull request for this branch is already open, update it instead of opening another.

```bash
git push -u origin HEAD
gh pr create --base main --head <branch> --title "<imperative summary>" --body "<body>"
```

The body must say what problem the change solves, why it is needed, the approach, important trade-offs, how it was tested, and any migration or compatibility impact. For a meaningful UI change, include screenshots or recordings. Keep the pull request focused.

## 5. Sign the CLA when this account has not already done so

`CONTRIBUTING.md` and `CLA.md` require this comment once, before a pull request is merged:

> I have read the CLA Document and I hereby sign the CLA.

Resolve the authenticated login with `gh api user --jq .login`. Search existing issue and pull-request comments in `alessandrobrunoh/trama` for that exact sentence from that login. If it is already there, do not comment again. If it is not, post that sentence unchanged on this pull request:

```bash
gh pr comment <number> --body "I have read the CLA Document and I hereby sign the CLA."
```

Do not paraphrase the sentence. Do not treat a review approval as a signature.

## 6. Wait for the checks that apply to this commit

Required checks are the checks GitHub runs for the pull request head being merged, not an older commit.

The only workflow is CLI CI (`.github/workflows/cli-ci.yml`). It runs on a pull request only when the diff touches `cli/**`, `mcp/src/**`, `skills/trama-cli/**`, or `.github/workflows/cli-*.yml`. Its jobs are `test` on `ubuntu-latest`, `macos-latest`, and `windows-latest`, plus `install.sh`. There is no branch protection and no ruleset on `main`, so GitHub will not block a merge by itself. This workflow still does not merge until the checks below are green.

- If the diff touches those paths, wait until every CLI CI job on the current head SHA has passed. Pending, failing, missing, or unverifiable jobs are not success. `gh pr checks <number>` must show those jobs passed for that SHA before you merge. Do not merge while they are queued or in progress, and do not merge because a different SHA passed.
- If the diff does not touch those paths, CLI CI does not run. Confirm `gh pr checks <number>` reports no checks for this head. That absence is expected. Do not invent extra required checks, and do not treat their absence as a failure.

Re-run this step after any new commit pushed to the pull request.

## 7. Merge, unless there is a conflict

Merge with a merge commit, which is how existing pull requests landed on `main` (`allow_merge_commit` is on). Do not pass `--squash`, `--rebase`, or `--delete-branch`.

```bash
gh pr merge <number> --merge
```

On a conflict, stop immediately. Do not resolve it, do not edit conflict markers, and do not retry with another merge strategy. Report that the changes have not landed, and describe the conflict so the user can decide.

Also stop, without merging, if the merge would overwrite commits or uncommitted work that is not part of this landing, or if the pull request head moved after the checks in step 6 were verified. In that case go back to step 6 for the new head.

## 8. Confirm the landing

Confirm the pull request is `MERGED` and `origin/main` contains the merge commit:

```bash
gh pr view <number> --json state,mergeCommit,url
git fetch origin main
git merge-base --is-ancestor <merge-commit-sha> origin/main
```

Report the pull request URL and the merge commit on `origin/main`. If the merge commit is not on `origin/main`, the changes have not landed.
