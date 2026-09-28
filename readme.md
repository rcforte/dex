# Dex User Manual

Dex is a Claude Code plugin for adding a feature to an existing codebase without handing the
thinking to the AI. It splits the work into stages. Each stage is one slash command that writes
one markdown file. You approve the important stages yourself, and Dex blocks code edits and
`git push` until you have.

The plugin itself lives in `dex/`. `dex/README.md` has the design rationale. This file explains
how to use it.

## What you need

- Node.js 18 or newer.
- git. The project you work on must be a git repository with a `main`, `master`, `develop` or
  `trunk` branch, or an `origin/HEAD`.
- Optional: the GitHub CLI `gh`, to open the pull request for you.

Dex has no npm dependencies.

## Loading Dex into a project

Start Claude Code from inside your project and point it at the plugin folder:

```bash
cd ~/dev/code/my-project
claude --plugin-dir ~/dev/code/dex-harness/dex
```

Then check the setup:

```
/dex:doctor
```

`/dex:doctor` checks Node, git, `gh`, and that every part of the plugin is present. It exits with
an error if something required is missing. It also creates two empty folders in your project,
`.dex/` and `docs/dex/`.

Nothing is copied into your project's `.claude/` folder. The plugin carries its own hook.

## The workflow

Every command after `start` takes the feature's short name, called the *slug*. Dex makes the slug
from your description. For "Add CSV export to reports" it would be something like
`csv-report-export`. `/dex:start` tells you the slug it picked.

| Step | You run | Dex writes | Your job |
|---|---|---|---|
| 1 | `/dex:start <what you want>` | `01-intent.md` | Read it. It states the problem, not a solution. |
| 2 | `/dex:questions <slug>` | `02-questions.md` | Edit the questions, then `/dex:approve questions <slug>`. |
| 3 | `/dex:research <slug>` | `03-research.md` | Read the findings. |
| 4 | `/dex:design <slug>` | `04-design.md` | Talk the design through, then `/dex:approve design <slug>`. |
| 5 | `/dex:structure <slug>` | `05-structure.md` | Check types and checkpoints, then `/dex:approve structure <slug>`. |
| 6 | `/dex:plan <slug>` | `06-plan.md` | Skim the plan. No approval needed. |
| 7 | `/dex:worktree <slug>` | a new branch and folder | Nothing. Code edits are now allowed. |
| 8 | `/dex:implement <slug> S1`, then `S2`, … | `07-implementation-log.md` | Watch each checkpoint land. |
| 9 | `/dex:verify <slug>` | test results in Dex's state | Nothing if it passes. |
| 10 | `/dex:review <slug>` | `08-review.md` | Fix anything marked as a blocker. |
| 11 | `/dex:status <slug> --review` | a guide to reading the diff | Read the diff, then `/dex:approve code <slug>`. |
| 12 | `/dex:pr <slug>` | `09-pr.md`, a commit, a push, a PR | Confirm the push when asked. |

All the markdown files go in `docs/dex/<slug>/` in your main checkout.

### What each stage does

- **Start.** Dex first asks whether the change is big enough to need it. For a typo, rename or
  one-line fix it will tell you to just make the change.
- **Questions.** Neutral questions about how the codebase works today. They do not mention the
  feature, so the research stays unbiased.
- **Research.** Several helper agents each answer one question. They never see the feature
  request. A second agent then tries to prove each answer wrong. Every finding is labelled as a
  fact (with a file and line range), an inference, or an unknown.
- **Design.** A conversation with you. When the codebase does the same thing two different ways,
  Dex asks you which to follow. The file ends with the decisions Dex is least sure about.
- **Structure.** The types, function signatures, and files to change. The work is split into
  checkpoints named S1, S2 and so on. Each checkpoint cuts through every layer and can be
  checked on its own.
- **Plan.** Step-by-step instructions for each checkpoint, including the exact command that
  proves it works.
- **Worktree.** Makes a branch `dex/<slug>` in a sibling folder `../<repo>-dex-<slug>`. Your main
  checkout stays untouched. Commit or stash your work first; Dex stops if the tree is dirty.
- **Implement.** Builds exactly one checkpoint, runs its check, logs it, and stops. Run the
  command again for the next one. If the code turns out to contradict the design, Dex stops and
  marks the feature as blocked. See "When the design turns out wrong" below.
- **Verify.** Finds your project's real test and build commands and runs them.
- **Review.** Agents review the diff for correctness, design fit, error handling and test
  coverage. The result is either PASS or REMEDIATION REQUIRED.
- **Code approval.** Your approval is tied to the exact diff. If the code changes afterwards,
  the approval goes stale and you must read the diff again.
- **PR.** Commits in the worktree, pushes, and runs `gh pr create`. Without `gh` it prints the PR
  body and the command for you to run.

### Commands you can use at any time

- `/dex:status [slug]` shows every stage and whether it is done, approved or stale.
- `/dex:next [slug]` prints the one command you should run next.
- `/dex:resume <slug>` picks a feature back up in a new session. It loads only the files the next
  stage needs.

Start a fresh session with `/dex:resume` after research, and whenever the conversation gets long.
Each stage is written to disk, so nothing is lost.

## What Dex blocks, and when

A hook checks every file edit and shell command Claude tries to run.

**Before the worktree exists**, Claude may only write inside `docs/dex/` and `.dex/`. Dex refuses
shell commands that change the repo. For example: `git commit`, `rm`, `sed -i`, `npm install`,
database migrations, or redirecting output into a file. Reading files, running tests and
building are allowed.

**Until the PR stage is unlocked**, Dex refuses any command that publishes work. For example:
`git push`, `gh pr create`, or `gh pr merge`.

The PR stage unlocks when all four are true:
- verification passed;
- the AI review passed;
- you approved the code;
- that approval still matches the current diff.

An approval is tied to the exact contents of the file you approved. Change the file and the
approval shows as STALE until you approve it again.

When no Dex feature is active, the hook allows everything.

## When the design turns out wrong

During `/dex:implement`, Dex may find that the real code contradicts the design. It then marks the
feature as blocked. To continue:

1. Fix the design with `/dex:design <slug>` or the structure with `/dex:structure <slug>`.
2. Approve the changed file again.
3. Unblock the feature from a terminal:

```bash
node ~/dev/code/dex-harness/dex/scripts/state.mjs unblock <slug>
```

There is no slash command for unblocking.

## Settings

Dex creates `.dex/config.json` the first time you run `/dex:start`. It never overwrites the file.

| Setting | Default | Effect |
|---|---|---|
| `strictGates` | `true` | When `false`, you may approve stages out of order and approve code before tests pass. Code edits and pushing stay gated. |
| `requireWorktree` | `true` | When `false`, you can implement in your main checkout. |
| `requireAiReview` | `true` | When `false`, the PR does not need an AI review. |
| `requireHumanCodeApproval` | `true` | When `false`, the PR does not need your code approval. |
| `reviewCadence` | `"final"` | How often Dex reminds you to review: `slice` (every checkpoint), `checkpoint` (after the first one), or `final` (before the PR). Reminders only. |
| `maxResearchWorkers` | `6` | Research only answers this many questions. See the warning below. |
| `artifactRoot` | `"docs/dex"` | Where the markdown files go. |
| `stateRoot` | `".dex"` | Where Dex keeps its state. Leave this alone; changing it splits the settings from the state. |

## Things to watch out for

- **Research only answers the first 6 questions.** The questions stage may write up to 12. The rest
  are listed as "Not researched". Keep the list to 6 or raise `maxResearchWorkers` (up to 24).
- **Run Claude from the main checkout, not the worktree.** Dex's state lives in `.dex/` in the main
  checkout. A session started inside the worktree cannot see it, so nothing is gated there.
- **The PR does not include the `docs/dex/` files.** They stay in your main checkout. Decide
  yourself whether to commit them. Many teams add `.dex/` to `.gitignore`.
- **Once code edits are allowed, they are allowed everywhere.** After the worktree exists, the hook
  no longer limits where Claude writes. Only publishing stays blocked.
- **The command check is a safety net, not a wall.** It matches known commands by pattern. A
  script that writes files through `python -c` or `node -e` will get through.
- **Dex never deletes branches or worktrees.** Clean up after merging with
  `git worktree remove ../<repo>-dex-<slug>` and `git branch -d dex/<slug>`.
- **`/dex:research` and `/dex:review` work best with Claude Code's Workflow tool.** Without it they
  fall back to running helper agents one by one, which is slower.

## Command-line tools

Everything the slash commands do goes through `dex/scripts/state.mjs`. You can call it directly from
your project folder:

```bash
node ~/dev/code/dex-harness/dex/scripts/state.mjs help
```

The commands you will most likely need by hand:
- `list` shows all features.
- `active <slug>` switches which feature the hook guards.
- `unblock <slug>` clears a blocked feature.
- `events <slug>` shows the feature's history.
- `verification <slug> reset` clears a recorded test result.

## Running Dex's own tests

```bash
node --test dex/tests/*.test.mjs
```

There are 123 tests. Each one builds a throwaway git repo in the system temp folder.
