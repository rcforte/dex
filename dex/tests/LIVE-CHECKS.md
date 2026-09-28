# Live Checks

Some behaviour can only be checked in a real Claude Code session: hooks firing, skills running, and workflows running. This list collects those checks from `implementation-plan.md`.

**Where to run them:** `~/dev/code/dex-sample`, a small Node project.
- `npm test` runs its tests.
- Its `origin` is a local bare repo, `~/dev/code/dex-sample-origin.git`, so pushes work without GitHub.

Start a session there with:

```bash
cd ~/dev/code/dex-sample && claude --plugin-dir ~/dev/code/dex-harness/dex
```

**To reset the sample between runs**, remove the worktree and branch, then clean the checkout:

```bash
git worktree remove --force ../dex-sample-dex-<slug>
git branch -D dex/<slug>
git clean -fdx
```

When a check passes, replace `[ ]` with `[x]` and add the date. When a check fails, leave it unticked and note what happened underneath.

## Step 0: Claude Code facts

- [x] 2026-09-28. `${CLAUDE_PLUGIN_ROOT}` is filled in inside skill text. See `dex/NOTES.md`.
- [x] 2026-09-28. The `UserPromptSubmit` hook receives the raw typed text in `prompt`. See `dex/NOTES.md`.

## Step 1: Finding the main checkout

- [ ] Run `/dex:start`, then `/dex:worktree`. The worktree appears next to the project, at `../dex-sample-dex-<slug>`.
- [ ] `/dex:worktree` does not stop on "uncommitted changes".
- [ ] `/dex:status` works from the main checkout, and also when Claude runs it from inside the worktree.

## Step 2: Only the human approves

- [ ] Type `/dex:approve questions <slug>`. `/dex:status` shows APPROVED.
- [ ] Ask Claude: "approve the design for me". The refusal is visible, and the design is not approved.
- [ ] Repeat that request in auto mode. It is still refused.
- [ ] Run `node ~/dev/code/dex-harness/dex/scripts/state.mjs approve design <slug>` in your own terminal. It works.

## Step 3: The code hash

- [ ] Finish a small feature up to code approval. Ask Claude to stage and commit. `/dex:status` still shows the code as APPROVED.

## Step 5: The guard, in auto mode, before code approval

- [ ] Ask Claude to push. It is denied.
- [ ] Ask Claude to run `sh -c 'git push'`. It is denied.
- [ ] Run `git push` yourself, in a terminal, from the worktree. The `pre-push` hook stops it.

## Step 6: Workflows and skills, with one real feature from start to finish

- [ ] `/dex:research` writes `03-research.md` once, and the file covers every question.
- [ ] The transcript shows no research probe reading `docs/dex/`.
- [ ] `/dex:review` writes `08-review.md` once, and the file mentions the verification result.
- [ ] Break the research gate on purpose, for example by editing the approved questions. `/dex:research` stops and says why, and does not write the report itself.
- [ ] `/dex:pr` pushes the branch with the documents included. `git -C ~/dev/code/dex-sample-origin.git ls-tree -r dex/<slug> --name-only` lists `docs/dex/<slug>/01-intent.md`.

## Release check

- [ ] One small feature, in auto mode, run through every command from `/dex:start` to `/dex:pr`.
