# Dex User Manual

Dex is a Claude Code plugin for adding a feature to an existing codebase without handing the
thinking to the AI. It splits the work into stages. Each stage is one slash command that writes
one markdown file. You approve the important stages yourself. Until you have, Dex blocks code
edits and pushes.

The plugin itself lives in `dex/`. `dex/README.md` explains why Dex is built this way. This file
explains how to use it.

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

`/dex:doctor` checks:
- Node, git and `gh`;
- that every part of the plugin is present;
- whether the git pre-push hook is installed.

It changes nothing in your project.

Nothing is copied into your project's `.claude/` folder. The plugin carries its own hooks.

## The workflow

Every command after `start` takes the feature's short name, called the *slug*. Dex makes the slug
from your description. For example, "Add CSV export to reports" might become `csv-report-export`.
`/dex:start` tells you the slug it picked.

| Step | You run | Dex writes | Your job |
|---|---|---|---|
| 1 | `/dex:start <what you want>` | `01-intent.md` | Read it. It states the problem, not a solution. |
| 2 | `/dex:questions <slug>` | `02-questions.md` | Edit the questions, then type `/dex:approve questions <slug>`. |
| 3 | `/dex:research <slug>` | `03-research.md` | Read the findings. |
| 4 | `/dex:design <slug>` | `04-design.md` | Talk the design through, then type `/dex:approve design <slug>`. |
| 5 | `/dex:structure <slug>` | `05-structure.md` | Check types and checkpoints, then type `/dex:approve structure <slug>`. |
| 6 | `/dex:plan <slug>` | `06-plan.md` | Skim the plan. No approval needed. |
| 7 | `/dex:worktree <slug>` | a new branch, a folder, a git hook | Nothing. Code edits are now allowed. |
| 8 | `/dex:implement <slug> S1`, then `S2`, … | `07-implementation-log.md` | Watch each checkpoint land. |
| 9 | `/dex:verify <slug>` | test results in Dex's state | Nothing if it passes. |
| 10 | `/dex:review <slug>` | `08-review.md` | Fix anything marked as a blocker. |
| 11 | `/dex:status <slug> --review` | a guide to reading the diff | Read the diff, then type `/dex:approve code <slug>`. |
| 12 | `/dex:pr <slug>` | `09-pr.md`, a commit, a push, a PR | Confirm the push when asked. |

The markdown files are written to `docs/dex/<slug>/` in your main checkout. At the end,
`/dex:pr` copies them into the pull request.

### What each stage does

- **Start.** Dex first asks whether the change is big enough to need it. For a typo, rename or
  one-line fix, it will tell you to just make the change.
- **Questions.** Neutral questions about how the codebase works today. They do not mention the
  feature, so the research stays unbiased. You can add your own questions under "Human Notes".
- **Research.** Helper agents each answer one question. They never see the feature request.
  They can read the code but not change it, and they are told to stay out of Dex's own folders.
  A second agent then tries to prove each answer wrong. Every question is researched, including
  your Human Notes. Every finding is labelled as a fact (with a file and line range), an
  inference, or an unknown.
- **Design.** A conversation with you. When the codebase does the same thing two different ways,
  Dex asks you which to follow. The file ends with the decisions Dex is least sure about.
- **Structure.** The types, function signatures, and files to change. The work is split into
  checkpoints named S1, S2 and so on. Each checkpoint cuts through every layer and can be
  checked on its own.
- **Plan.** Step-by-step instructions for each checkpoint, including the exact command that
  proves it works.
- **Worktree.** Makes a branch `dex/<slug>` in a sibling folder, `../<repo>-dex-<slug>`. Your main
  checkout stays untouched. Commit or stash your own work first. Dex's files don't count as
  uncommitted work. This step also installs a git pre-push hook (see "What Dex blocks").
- **Implement.** Builds exactly one checkpoint, runs its check, logs it, and stops. Run the
  command again for the next one. If the code turns out to contradict the design, Dex stops and
  marks the feature as blocked. See "When the design turns out wrong" below.
- **Verify.** Finds your project's real test and build commands and runs them.
- **Review.** Agents review exactly the diff you will approve, new files included. They look at
  correctness, design fit, error handling and test coverage. The result is either PASS or
  REMEDIATION REQUIRED.
- **Code approval.** Your approval covers the exact code that `/dex:status <slug> --review`
  showed you. Staging and committing it doesn't change that. Any real change to the code makes
  the approval stale, and you read the diff again.
- **PR.** Copies the Dex documents into the worktree, commits, pushes, and runs `gh pr create`.
  Without `gh` it prints the PR body and the command for you to run.

### Commands you can use at any time

- `/dex:status [slug]` shows every stage and whether it is done, approved or stale.
- `/dex:next [slug]` prints the one command you should run next.
- `/dex:resume <slug>` picks a feature back up in a new session. It loads only the files the next
  stage needs.

Start a fresh session with `/dex:resume` after research, and whenever the conversation gets long.
Each stage is written to disk, so nothing is lost.

## Approving

Only you can approve. Type the command yourself:

```
/dex:approve <questions|design|structure|code> <slug>
```

A hook sees what you type and records the approval before Claude reads your message. Claude
cannot approve on your behalf. Dex refuses the approve command when Claude runs it, and refuses
any edit to Dex's state folder, `.dex/`.

If the hook ever fails, run the same approval in your own terminal:

```bash
node ~/dev/code/dex-harness/dex/scripts/state.mjs approve <gate> <slug>
```

An approval is tied to the exact content you approved. Change the file (or, for code, the code)
and the approval shows as STALE until you approve again. Re-approving the questions with new
content also makes the design stale, and re-approving the design makes the structure stale.

## What Dex blocks, and when

A hook checks every file edit and shell command Claude tries to run. It reads commands the way a
shell does, so quoting tricks, `sh -c`, `eval` and wrappers such as `env` or `sudo` don't hide
anything.

**Always:** recording an approval, and writing to `.dex/`.

**Before implementation is unlocked**, Claude may only write inside `docs/dex/`. Dex refuses shell
commands that change the repository. For example: `git commit`, `rm`, `touch`, `sed -i`, code
formatters that rewrite files, `npm install`, database migrations, inline scripts that write
files, and redirecting output into the repository. Reading files, running tests and building are
allowed. To keep a test log, write it to `$TMPDIR`.

Implementation unlocks when:
- the questions, design and structure are approved and current;
- the plan exists;
- the worktree is ready.

**Until publishing is unlocked**, Dex refuses anything that publishes work: `git push` in any
form, PR commands, write calls to the GitHub or GitLab API, and package or image uploads.

Publishing unlocks when all of these are true:
- everything implementation needs is still true;
- every checkpoint is complete;
- verification and the AI review passed on the current code;
- you approved the current code;
- the commit being pushed holds exactly that code.

**The git pre-push hook** is a second lock on publishing. git runs it before every push, however
the push was started, even from your own terminal. It refuses a `dex/*` branch that hasn't passed
the gates, and lets every other branch through. `/dex:worktree` installs it. If your project
already has a pre-push hook, or uses `core.hooksPath` (for example with husky), Dex will not
touch it. It prints one line for you to add instead.

When no Dex feature is active, the hook allows everything. If Dex cannot tell which feature's
gates apply, it blocks changes and still allows reading. That happens when:
- its state can't be read;
- several features are active and none is selected.

To select one, use `/dex:resume <slug>`.

## When the design turns out wrong

During `/dex:implement`, Dex may find that the real code contradicts the design. It then marks the
feature as blocked. To continue:

1. Fix the design with `/dex:design <slug>`, or the structure with `/dex:structure <slug>`.
   `/dex:next <slug>` tells you which one.
2. Type `/dex:approve design <slug>` or `/dex:approve structure <slug>`. If you changed the
   design, approve the structure again too.

Dex unblocks the feature by itself once every approval is current again.

## Settings

Dex creates `.dex/config.json` the first time you run `/dex:start`. It never overwrites the file.

| Setting | Default | Effect |
|---|---|---|
| `strictGates` | `true` | When `false`, you may approve documents in any order. Every approval is still required before code edits and before the PR. |
| `requireWorktree` | `true` | When `false`, you implement in your main checkout. Dex pins the commit you started from, so the approval still covers exactly your changes. |
| `requireAiReview` | `true` | When `false`, the PR does not need an AI review. |
| `requireHumanCodeApproval` | `true` | When `false`, the PR does not need your code approval. |
| `reviewCadence` | `"final"` | How often Dex reminds you to review: `slice` (every checkpoint), `checkpoint` (after the first one), or `final` (before the PR). Reminders only. |
| `maxResearchWorkers` | `6` | How many research agents run at once, from 1 to 24. Every question is researched either way. |
| `artifactRoot` | `"docs/dex"` | Where the markdown files go. Must be a folder inside the repository. |
| `stateRoot` | `".dex"` | Where Dex keeps its state. Must be a folder inside the repository. `config.json` always stays in `.dex/`. |

## Things to watch out for

- **Once code edits are allowed, they are allowed everywhere in the repository.** After the
  worktree exists, the hook no longer limits which files Claude changes. It still blocks
  approvals, `.dex/` and publishing.
- **A script file can get past the edit check.** Dex reads commands, not the programs they run.
  Before implementation starts, `python tools/generate.py` could still write into the repository.
  Publishing is covered by the pre-push hook either way.
- **Keep the pre-push hook installed.** If you move the plugin folder, run
  `node <new path>/scripts/state.mjs install-hook` again. Until then the hook refuses `dex/*`
  pushes.
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
- `approve <gate> <slug>` records an approval, if the approval hook ever fails.
- `list` shows all features.
- `active <slug>` switches which feature the hook guards.
- `install-hook` installs the git pre-push hook again.
- `diff-hash <slug>` prints the exact diff your code approval would cover.
- `events <slug>` shows the feature's history.
- `verification <slug> reset` clears a recorded test result.

`dex/README.md` lists every command.

## Running Dex's own tests

```bash
node --test dex/tests/*.test.mjs
```

There are 284 tests. Each one builds a throwaway git repository in the system temp folder.
`dex/tests/LIVE-CHECKS.md` lists the checks that need a real Claude Code session.
