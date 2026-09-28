---
name: worktree
description: Prepare an isolated git worktree and branch for implementing a Dex feature. Invoke with /dex:worktree <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read
---

# /dex:worktree

Give the implementation its own working directory so nothing in progress gets
clobbered.

## 1. Check the prerequisite

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Proceed when the plan exists and the structure approval is valid. If
`gates.worktree.status` is `NOT-REQUIRED`, the project has turned worktrees off:
say so and go straight to `/dex:implement`. Otherwise the default is isolation.

## 2. Inspect the repository first — never discard user work

```bash
git status --porcelain -- . ':!<artifactRoot>'
git branch --show-current
```

`<artifactRoot>` is `config.artifactRoot` from the check output (`docs/dex` by
default). Dex's own files are left out of this check: the artifacts are listed
by that pathspec, and `.dex/` is ignored locally by `init`.

If there are uncommitted changes, **stop and ask**. Do not stash, reset, check
out over them, or clean. Someone's unsaved work is not yours to discard, and a
worktree can be created without touching it.

## 3. Choose a safe branch name

Preferred: `dex/<slug>`.

If it already exists, pick a non-conflicting variant — `dex/<slug>-2` — rather
than reusing or deleting the existing one:

```bash
git rev-parse --verify --quiet dex/<slug>
```

## 4. Create the worktree

```bash
git worktree add ../<repo-name>-dex-<slug> -b dex/<slug>
```

Use this command, not Claude Code's built-in worktrees. Dex supports one layout
only, and the built-in ones live inside the repository.

Place it **outside** the repository directory. A worktree nested inside the repo
gets picked up by build tools, test globs, and linters, and then fails in
confusing ways.

Note the base branch — the branch you branched from — because the human code
approval will be a diff against it.

## 5. Record it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" record-worktree <slug> <branch> <absolute-path> --base <base-branch>
```

The script refuses anything but a linked worktree of this repository on the
named branch, and refuses `HEAD` or the feature branch as the base.

## 6. Stop

Print the branch, the absolute path, and the base, then:

```text
Next:
/dex:implement <slug> S1
```

## Never

- Never `git worktree remove --force`, `git branch -D`, `git reset --hard`,
  `git clean`, or `git checkout --` on the user's branches.
- Never delete an existing worktree to reuse its path.
- If cleanup seems necessary, describe the command and let the user run it.
