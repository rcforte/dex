---
name: pr
description: Prepare and optionally create the pull request for a fully approved Dex feature, producing 09-pr.md. Invoke with /dex:pr <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /dex:pr

Prepare the pull request. This is the only command that may push.

## 1. Check every gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Proceed only when `gates.canPr.allowed` is true. It requires:

- all implementation checkpoints complete
- verification PASS
- AI review completed with no unresolved BLOCKER findings, when required
- human code review APPROVED
- that approval's tree still current

If blocked, print the blockers verbatim and stop. The PreToolUse guard refuses the
push independently, so there is nothing to gain by trying.

If the human code approval is `STALE`, the code changed after it was read. Say so
plainly: the diff needs reading again, then `/dex:approve code <slug>`. Do not
suggest re-approving without reading.

## 2. Write the PR body

Use `${CLAUDE_PLUGIN_ROOT}/templates/pr.md`, written to `09-pr.md`.

Include: summary, links to intent, design and structure, the checkpoint list, the
verification table with real exit codes, the AI review conclusion, the human code
approved tree and base commit from state, risk, and rollback.

The hash matters. It records exactly which diff a human read and approved.

## 3. Commit and push

Confirm with the user before pushing — this is the outward-facing, hard-to-reverse
step, and approval of the code is not by itself approval to publish it.

```bash
git -C <worktree> status --porcelain
git -C <worktree> add -A
git -C <worktree> commit -m "<message>"
git -C <worktree> push -u origin <branch>
```

Use the repository's existing commit message convention — check `git log`.

## 4. Create the PR

If `gh` is available:

```bash
gh pr create --base <base> --head <branch> --title "<title>" --body-file docs/dex/<slug>/09-pr.md
```

Otherwise print the body and the exact command for the user to run, including the
web URL if the remote is known. Do not invent a different publishing mechanism.

## 5. Record

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" record-pr <slug> --url "<pr-url>"
```

This re-checks every gate and refuses if any regressed.

## Never

- Never push or open a PR outside an explicit `/dex:pr` invocation.
- Never use `--force` or `--force-with-lease` unless the user asks and explains why.
- Never delete branches or worktrees as cleanup.
- Never use `--dangerously-skip-permissions`.
