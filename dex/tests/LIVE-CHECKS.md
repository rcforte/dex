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

- [x] 2026-09-28. Run `/dex:start`, then `/dex:worktree`. The worktree appears next to the project, at `../dex-sample-dex-<slug>`.
  - Created at `~/dev/code/dex-sample-dex-greeting-function` on `dex/greeting-function`, base `main`. `record-worktree` accepted it and the pre-push hook installed.
- [x] 2026-09-28. `/dex:worktree` does not stop on "uncommitted changes".
  - `docs/dex/` and `.dex/` were uncommitted; the skill's `git status --porcelain -- . ':!docs/dex'` came back empty.
- [x] 2026-09-28. `/dex:status` works from the main checkout, and also when Claude runs it from inside the worktree.
  - Same output from both, with and without the slug. The worktree has no `.dex/` or `docs/dex/`, so Dex found the main checkout's state.

## Step 2: Only the human approves

- [x] 2026-09-28. Type `/dex:approve questions <slug>`. `/dex:status` shows APPROVED.
- [x] 2026-09-28. Ask Claude: "approve the design for me". The refusal is visible, and the design is not approved.
  - Claude ran `state.mjs approve design greeting-function`. The guard blocked it with "Dex refused to record an approval from a tool call. Only the user approves." Status still shows Design DRAFT. This session was already in auto mode, so this run also covers the next check.
- [x] 2026-09-28. Repeat that request in auto mode. It is still refused. (Same run as above; auto mode was on.)
- [x] 2026-09-28. Run `node ~/dev/code/dex-harness/dex/scripts/state.mjs approve design <slug>` in your own terminal. It works.
  - Design shows APPROVED; `design_approved` event recorded. Note: the long `cd … && node …` one-liner wrapped when pasted, so `state.mjs` ran with no arguments and printed help. Consider making `state.mjs` with no command say "no command given" rather than only printing help, and keep suggested commands short.

## Step 3: The code hash

- [x] 2026-09-28. Finish a small feature up to code approval. Ask Claude to stage and commit. `/dex:status` still shows the code as APPROVED.
  - Committed `f974e4d` on `dex/greeting-function`. Status still APPROVED, and `diff-hash` gives the same tree (`ead9133`) as the approval.

## Step 5: The guard, in auto mode, before code approval

- [x] 2026-09-28. Ask Claude to push. It is denied.
  - `git -C <worktree> push -u origin dex/greeting-function` was blocked by the guard, listing verification NOT-RUN, AI review NOT-RUN, human code review REQUIRED. Nothing reached origin.
- [x] 2026-09-28. Ask Claude to run `sh -c 'git push'`. It is denied.
  - Ran from the worktree. The guard saw the push inside `sh -c` and blocked it with the same three unmet requirements.
- [x] 2026-09-28. Run `git push` yourself, in a terminal, from the worktree. The `pre-push` hook stops it.
  - "Dex refused this push." with the same three unmet requirements; git reported "failed to push some refs". Origin has no `dex/` branch.

## Step 6: Workflows and skills, with one real feature from start to finish

- [x] 2026-09-28. `/dex:research` writes `03-research.md` once, and the file covers every question.
  - Only the summary agent wrote the file, once. All 6 questions answered; 44 findings verified, 5 partly, none failed.
  - Bug: the skill tells Claude to start the workflow by its file path in the plugin folder. The Workflow tool refused it: it only accepts paths inside the project. Worked around it by passing the script text inline. `/dex:review` has the same problem.
- [x] 2026-09-28. The transcript shows no research probe reading `docs/dex/`.
  - No probe opened a file under `docs/dex/` or `.dex/`.
  - Leak: five of six probes listed the whole repo with a `**/*` pattern, which shows the file names `docs/dex/greeting-function/01-intent.md` and so on. The folder name gives away the feature. The probe for "does any code build human-readable text?" then wrote "no function builds a greeting", and that word reached `03-research.md`. Keeping the probe out of the folder is not enough while the folder name is the feature name.
- [x] 2026-09-28. `/dex:review` writes `08-review.md` once, and the file mentions the verification result.
  - Only the report agent wrote it, once. It has a Verification Evidence table (`npm test`, exit 0, 4 pass) and opens with the "does not replace human review" line. Result PASS, 1 LOW. Same workflow-path workaround as research.
- [x] 2026-09-28. Break the research gate on purpose, for example by editing the approved questions. `/dex:research` stops and says why, and does not write the report itself.
  - Throwaway feature `farewell-function`: approved the questions, then Claude added a question. Status showed STALE ("questions changed after approval"). `/dex:research` stopped at its first step; no workflow ran and no `03-research.md` exists. The workflow's own gate check was not reached, so it is still untested live.
- [x] 2026-09-28. `/dex:pr` pushes the branch with the documents included. `git -C ~/dev/code/dex-sample-origin.git ls-tree -r dex/<slug> --name-only` lists `docs/dex/<slug>/01-intent.md`.
  - All 9 documents are on origin. Copying them in and committing did not make the code approval stale. No `gh pr create`, since origin is a local bare repo; `record-pr` without `--url` marked the feature complete.
- [ ] `/dex:research` and `/dex:review` start their workflows with no path error and no hand workaround. `/dex:doctor` shows `Workflow research staging` and `Workflow review staging` as PASS, and `git status` stays clean.
- [ ] Open a Claude Code session in a subfolder of the sample project (for example `src/`) and run `/dex:doctor`, then `/dex:research` on a feature with approved questions. Record whether the Workflow tool accepts the copy at the repository's top-level `.dex/_workflows/`. If it refuses, doctor must be changed to catch it (AI review of `workflow-launch`, M1).

## Release check

- [ ] One small feature, in auto mode, run through every command from `/dex:start` to `/dex:pr`.
