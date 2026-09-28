# Dex Fix Plan

**Date:** 2026-09-27

This plan fixes findings 1–30 in `review-findings.md`. It also fixes the Low findings wherever they touch code a step already changes.

The plan is split into nine steps, numbered 0 to 8. Each step follows the same order:
1. Write the tests from the step's "How to test" table, and watch them fail.
2. Make the change.
3. Run the full suite: `node --test dex/tests/*.test.mjs`.
4. Run the step's live checks, if it has any.
5. Commit.

Paths are relative to `dex/`. "Finding N" refers to `review-findings.md`.

## Decisions

These were agreed before writing the plan.

| # | Question | Decision |
|---|---|---|
| Q1 | Can the model approve its own work? | No. Only a step the human takes can record an approval. The model cannot write to `.dex/`. |
| Q2 | Where is Dex state found? | Always in the main checkout. Dex finds it from inside a worktree too. |
| Q3 | What does `maxResearchWorkers` limit? | How many research agents run at once. Every approved question gets researched. |
| Q4 | Does a changed earlier file make later approvals stale? | Yes, one level. The design records the hash of the questions it was built on; the structure records the design's. |
| Q5 | What does `strictGates: false` allow? | Approving stages out of order. It never removes an approval requirement. |
| Q6 | Can you work on `main` without a worktree? | Yes. The base commit is pinned when implementation starts. |
| Q7 | What counts as publishing? | Anything that leaves the machine: push, PR commands, write calls to the GitHub or GitLab API, and package or image publishing. A git `pre-push` hook backs this up. |
| Q8 | Can verification and AI review run early? | No. Both need every checkpoint complete. |
| Q9 | How much gets fixed? | Findings 1–30, plus Low findings in code already being changed. |
| Q10 | Are Claude Code's built-in worktrees supported? | No. Only Dex's own sibling worktree, `../<repo>-dex-<slug>`. |
| Q11 | Where do the Dex documents go? | The markdown files are committed with the PR. `.dex/` is never committed. |
| Q12 | How is the `pre-push` hook installed? | `/dex:worktree` installs it. It gates only `dex/*` branches and never overwrites an existing hook. |
| Q13 | Put this project under git? | Yes. One commit per step. |
| Q14 | Who follows the plan? | The human. The plan is written so an agent could follow it too. |
| Q15 | How does the human approve? | A hook reads the `/dex:approve` messages you type. Running `state.mjs approve` in your own terminal is the backup. The model's calls to it are refused. |

---

## How testing works

Every change in this plan gets at least one test. The test must fail before the change and pass after it. A test that passes before the change proves nothing, so run each new test once against the old code before writing the fix.

Each test name starts with the finding it covers, such as `finding 4: staging after approval keeps it valid`. That makes it easy to mark findings fixed later.

There are three kinds of test.

**1. Automated tests** (`node --test dex/tests/*.test.mjs`). These are most of the work. Each test builds a throwaway git repo in the system temp folder, like the existing tests do. Step 0 adds these helpers to `tests/helpers.mjs`:

| Helper | What it does |
|---|---|
| `makeRepo({ origin: true })` | The existing repo helper, plus a bare repo wired up as `origin`, so real pushes can be tested. |
| `advanceTo`, `completeImplementation` | Already exist. They drive a feature to a given stage through the real CLI. |
| `runGuard(payload)` | Runs `scripts/guard.mjs` as a real process with the payload on stdin, and returns `allow` or `deny` with the reason. Most existing guard tests call `decide()` directly, which skips how the guard finds the repo and the feature. The new tests use `runGuard`. |
| `runPromptHook(prompt, cwd)` | Runs the new approval hook as a real process, the same way. |
| `runWorkflow(file, args, fakeAgent)` | Runs a workflow script in Node. It removes `export` from `meta` and runs the body as an async function. `agent`, `parallel`, `pipeline`, `phase` and `log` are fakes the test controls. The fake `agent` returns canned answers and records every prompt and option it was given. Today the workflows are only checked as text; this lets their logic be tested. |
| `staticText(glob)` | Reads skill, workflow and hook files, for checks such as "no skill runs `state.mjs approve`". |

**2. Real git.** The `pre-push` hook and `/dex:pr` are tested with real `git push` calls to the bare `origin`, not with guard payloads.

**3. Live checks in Claude Code.** Hooks firing, skills running and workflows running can only be fully tested in a real session. Each step lists its live checks. Run them in a small sample project: step 0 creates `~/dev/code/dex-sample`, a git repo with one source file, one test and a `main` branch. Tick each check off in `dex/tests/LIVE-CHECKS.md` with the date.

---

## Step 0: Baseline and the two unknowns

**Goal:** get a git history, answer two open facts, and add a test that fails today for the right reasons.

1. Run `git init` in `dex-harness/` and commit everything as "Baseline before review fixes".
2. **Check whether `${CLAUDE_PLUGIN_ROOT}` is filled in inside skill text.**
   - Add a throwaway skill that prints `${CLAUDE_PLUGIN_ROOT}`, and run it.
   - If it prints a real path, step 6 passes paths into workflows through skill text.
   - If it prints the text unchanged, the skills must find the plugin path another way. For example, a `SessionStart` hook could write it to `.dex/plugin-root`, since hooks do receive the variable.
3. **Check what the message-submit hook receives.**
   - Add a throwaway `UserPromptSubmit` hook that saves its stdin to a file in the system temp folder. Type `/dex:status foo`.
   - Record which field holds the prompt, and whether it is the raw typed text.
   - If it is not the raw text, step 2 drops the hook, and approval happens only in your own terminal.
4. Write both answers into `dex/NOTES.md`, then delete the throwaway skill and hook.
5. **Add `tests/e2e.test.mjs`.** It runs the documented flow in a temporary repo that has a bare `origin` remote. It calls the scripts directly and sends hook payloads to the guard:
   - init, then write and approve questions, design and structure;
   - write the plan, create the worktree with `git worktree add`, then `record-worktree`;
   - `set-slices`, then `start-slice` and `finish-slice` for S1;
   - verification pass, then review pass;
   - approve code;
   - `git -C <wt> add -A` and `commit`;
   - a guard payload for `git push` with `cwd` set to the worktree. **Expect: allowed.**

   Add a second case: the same push from the worktree before code approval. **Expect: denied.**

   Both cases fail today, because of findings 3, 4 and 10. They must pass by the end of step 3.
6. **Add `tests/skills-cli.test.mjs`.** It pulls every `state.mjs <command> --flag` out of `skills/**/SKILL.md` and `workflows/*.js`, and checks each command and flag exists in `state.mjs`.

7. **Build the test helpers** described in "How testing works": `runGuard`, `runPromptHook`, `runWorkflow`, `staticText`, and the `origin` option on `makeRepo`. Each helper gets one small test of its own. For example, `runWorkflow` runs `research.js` with a fake agent and returns its result object.
8. **Create the sample project** `~/dev/code/dex-sample` and the empty checklist `dex/tests/LIVE-CHECKS.md`.

### How to test step 0

| Change | Test | Expected |
|---|---|---|
| `${CLAUDE_PLUGIN_ROOT}` check | Live: run the throwaway skill in `dex-sample`. | A real path, or the literal text. Either way, the answer is recorded in `NOTES.md`. |
| Prompt hook check | Live: type `/dex:status foo`, then read the saved stdin file. | The field name, and whether it holds `/dex:status foo` exactly. Recorded in `NOTES.md`. |
| `e2e.test.mjs` | Run it. | Both cases fail, and the failure messages point at findings 3, 4 and 10. If they fail for any other reason, fix the test first. |
| `skills-cli.test.mjs` | Run it. Then add a made-up flag to one skill and run it again. | The made-up flag makes it fail. Remove the flag. |
| New helpers | Their own small tests. | Green. |

**Done when** `NOTES.md` answers both questions and the two new test files exist. `e2e` is red. `skills-cli` is green, or red for known reasons. The helpers and the sample project exist.

---

## Step 1: Find the main checkout from anywhere

**Fixes:** 3, 10, 23. **Decisions:** Q2, Q10, Q11 (the `.dex/` ignore part).

1. **`lib.mjs` `findRepoRoot`.**
   - Run `git rev-parse --path-format=absolute --git-common-dir`.
   - If the result ends in `.git`, return its parent.
   - Keep the walk-up search for `.dex/` as a fallback when git isn't available.

   The guard, `state.mjs`, `status.mjs` and `doctor.mjs` all use this function, so they all get the fix.
2. **`init` adds `.dex/` to `<common-dir>/info/exclude`.** It adds it only once, and creates the file if needed.
3. **`skills/worktree/SKILL.md`.**
   - Check for a dirty tree with `git status --porcelain -- . ':!.dex' ':!<artifactRoot>'`.
   - Always create the worktree with `git worktree add ../<repo>-dex-<slug> -b dex/<slug>`.
   - Remove the built-in worktree option.
   - Read `requireWorktree` from `state.mjs check`, not from the config file.
4. **All skills.** Use `git -C <worktree>` and absolute paths. Never `cd` into the worktree.
5. **`requireWorktree` is read live.** `computeGates` reads it from the loaded config, not from `state.worktree.required`. Remove that field from `newFeatureState`. Existing state files keep working, because the field is simply ignored.
6. **`record-worktree` checks the path.**
   - The path must appear in `git worktree list --porcelain`.
   - It must not be the main checkout.
   - Its branch must match the branch given.
   - `--base` must name a real commit, and must not be `HEAD` or the feature's own branch. (It may point at the same commit as the worktree when the worktree is new; that is the normal case.)

### How to test step 1

| Change | Test | Expected |
|---|---|---|
| `findRepoRoot` from a worktree | `advanceTo(root, 'feat', 'worktree')`, then `state(worktree, ['check', 'feat'])`. | The feature is found. |
| … from a subfolder of the worktree | The same, with `cwd` set to `<worktree>/src`. | The feature is found. |
| … with no git | `makeRepo({ git: false })` with a `.dex/` folder. | The feature is found through the walk-up fallback. |
| Guard from the worktree | `runGuard` with `git push` and `cwd: worktree`, before code approval. | `deny`. This is the case that fails today. |
| `.dex/` ignored | Run `init`, then `git status --porcelain`. Run `init` for a second feature and read `info/exclude`. | No `.dex` line in the status. Exactly one `.dex/` line in the exclude file. |
| Dirty-tree check | Run `init`, then the exact `git status` command from the worktree skill. | Empty output. |
| Worktree skill text | `staticText`: the worktree skill has no built-in worktree option. No skill contains `cd <worktree>`. | Both pass. |
| `requireWorktree` read live | Run `init`. Set it to `false` and run `check`. Set it back to `true` and run `check`. | NOT-REQUIRED, then NOT-READY. |
| `record-worktree` checks | Pass: a plain folder, the main checkout, a wrong branch name, `--base HEAD`, `--base dex/<slug>`, and then a valid worktree. | The first four are refused with a clear reason. The valid one is accepted. |

**Live check:** in `dex-sample`, run `/dex:start` and then `/dex:worktree`.
- The worktree appears next to the project.
- The command does not stop on "uncommitted changes".
- `/dex:status` works both from the main checkout and after asking Claude to run it from the worktree.

---

## Step 2: Only the human approves

**Fixes:** 1, 2, 7, 19. **Decisions:** Q1, Q15.

1. **New hook `scripts/approve-hook.mjs`, registered under `UserPromptSubmit` in `hooks/hooks.json`.**
   - Match the prompt field from step 0 against `^\s*/dex:approve\s+(questions|design|structure|code)\s+([a-z0-9-]+)\s*$`.
   - On a match, run the approval in-process: export the approve function from `state.mjs`, don't spawn a process.
   - Return the result to Claude as `additionalContext`. Never block the prompt.
2. **`skills/approve/SKILL.md`.** Remove the Bash approve call. The skill reads `state.mjs status <slug>` and reports whether the approval was recorded. If it was not recorded, the skill tells the user to run `node <plugin>/scripts/state.mjs approve <gate> <slug>` in their own terminal.
3. **The guard refuses the model's approvals.** It denies any Bash command that runs `state.mjs` with an `approve` argument, in either argument order. The reason text points the user to `/dex:approve`.
4. **The guard protects `.dex/`.**
   - Edit tools may write only under `<artifactRoot>/**`.
   - Writes to `<stateRoot>/**` are denied, whether by edit tools, redirects, `tee`, `cp`, `mv` or `rm`.
   - Change the test at `tests/guard.test.mjs:105` to expect this.
   - `state.mjs` itself still writes there, because it runs as `node`, not as an edit tool.
5. **Unreadable state blocks changes.**
   - `lib.mjs` `readJson` returns the fallback only for a missing file (`ENOENT`) and throws on a parse error.
   - `listFeatures` records unreadable features instead of skipping them.
   - If any feature folder can't be read, or `.dex/active` names a feature that can't be loaded, the guard denies all changes and all publishing.
   - The guard's crash handler denies changes too. It still allows reading.
6. **Choosing which feature to check.**
   - Every `state.mjs` command that takes a slug and changes something also sets `.dex/active`.
   - The guard looks for a matching feature first:
     1. a feature whose recorded worktree contains the tool's target path or `cwd`;
     2. otherwise the active feature;
     3. otherwise, if features exist but none can be picked, deny changes.

### How to test step 2

| Change | Test | Expected |
|---|---|---|
| Approval hook | `runPromptHook('/dex:approve questions feat')`, after the questions are written. | Questions APPROVED. The hook's output contains `additionalContext` that says so. |
| … other prompts | `runPromptHook` with `hello`, `/dex:status feat`, `/dex:approve questions feat please`, and `/dex:approve questions ../x`. | No state change. No approval output. |
| … refused approval | `runPromptHook('/dex:approve design feat')` before questions are approved. | No state change. The context explains why. |
| Hook registered | `staticText`: `hooks.json` has a `UserPromptSubmit` entry that points at the approval hook. | Pass. |
| Approve skill | `staticText`: the approve skill does not contain `state.mjs approve`. | Pass. |
| Guard refuses model approvals | `runGuard` with:<br>- `node /p/state.mjs approve design feat`<br>- the reversed argument order<br>- extra spaces<br>- `cd x && node state.mjs approve …`<br>- `sh -c "node state.mjs approve …"` | All `deny`. The last one passes only after step 5; mark it as expected to fail until then. |
| … but allows other CLI calls | `runGuard` with `node state.mjs status feat` and `node state.mjs transition feat design-updated`. | `allow`. |
| `.dex/` protected | `runGuard` with:<br>- Write `.dex/config.json`<br>- Edit `.dex/feat/state.json`<br>- `echo {} > .dex/config.json`<br>- `cp x .dex/feat/state.json`<br>- `rm -rf .dex` | All `deny`, in every phase including after full approval. |
| Artifacts still writable | `runGuard` with Write `docs/dex/feat/04-design.md`. | `allow`. |
| `readJson` | Unit test on a missing file, then on a file containing `{`. | The fallback, then a thrown error. |
| Corrupt state blocks changes | Write `{ "schemaVersion": 1, ` into `state.json`. `runGuard` with Write `src/A.java`, `git push`, `sh -c "git push"` and `cat src/A.java`. | `deny`, `deny`, `deny`, `allow`. |
| … broken active marker | Two features, and `.dex/active` naming one that doesn't exist. `runGuard` with Write `src/A.java`. | `deny`. |
| … config `[]` | `runGuard` with Write `src/A.java`. | `deny`. Today this crashes and allows. |
| Feature chosen by worktree | Feature A is in its worktree and ready to implement. Feature B is early and active. `runGuard` with Write `<A's worktree>/src/X.java`, then Write `src/X.java` in the main checkout. | `allow`, then `deny`. |
| Commands set the active feature | Run `start-slice B S1` while A is active. | `.dex/active` now says `B`. |

**Live checks** in `dex-sample`:
- Type `/dex:approve questions <slug>`. `/dex:status` shows APPROVED.
- Ask Claude: "approve the design for me". The refusal is visible, and the design is not approved.
- Repeat that request in auto mode. It is still refused.
- If step 0 ruled out the hook: run `node …/state.mjs approve questions <slug>` in your own terminal. It works.

---

## Step 3: Rewrite the code hash

**Fixes:** 4, 5, 6, 11, 30, 38. **Decisions:** Q6, Q8, Q11 (the artifacts part).

The approval should cover exactly what gets pushed, and it should not change when files are staged or committed.

1. **Pin the base commit.**
   - `record-worktree` stores `baseSha = git merge-base <base> HEAD`.
   - With `requireWorktree: false`, the first `start-slice` stores it.
   - Approval is refused when `baseSha` is missing.
2. **New hash: the tree of the whole working state.**
   - In `lib.mjs`, replace `diffFingerprint` with `workTree(dir, slug)`. It uses a temporary index file (`GIT_INDEX_FILE`):
     1. `git read-tree HEAD`;
     2. `git add -A`, which respects `.gitignore`;
     3. `git rm --cached -q --ignore-unmatch` for this feature's artifact files only: `<artifactRoot>/<slug>/0[1-9]-*.md`;
     4. `git write-tree`.
   - The result is a tree SHA. The approval stores `{ baseSha, tree }`.
   - Staging or committing doesn't change the tree, which fixes finding 4.
   - A change anywhere else, including a new commit on `main`, does change it. That fixes finding 5 for working on `main`.
3. **Check what is being pushed.** For publishing, also require:
   - the working tree is clean;
   - `HEAD^{tree}`, with the artifact files removed the same way, equals the approved tree.

   This stops the commit-then-revert trick.
4. **Only Dex's own files are skipped.** Remove the `docs/dex/**` and `.dex/**` exclusions from hashing.
5. **Config checks.** In `lib.mjs` config validation, reject `artifactRoot` and `stateRoot` when they are `.`, contain `..`, are absolute, or resolve outside the repo. `loadConfig` reads `<stateRoot>/config.json` consistently. `review.js` takes the roots from `args`.
6. **Results are tied to the tree.**
   - `verification` and `record-review` store the current tree. A stored tree that no longer matches counts as NOT-RUN.
   - Both commands refuse to run unless every checkpoint is complete (Q8).
7. **`status --review` uses the same base.** It lists files from `git diff --name-status <baseSha> <tree>`. Renames are checked on both sides.
8. **Speed.** The guard computes the tree only for publish commands, not for every tool call (finding 40).

### How to test step 3

Most cases start from `advanceTo(…, 'worktree')`, `completeImplementation`, and an approved code gate.

| Change | Test | Expected |
|---|---|---|
| Base pinned | After `record-worktree`, read the state. Then do the same with `requireWorktree: false` after the first `start-slice`. | `baseSha` equals `git merge-base main HEAD`, in both cases. |
| No base, no approval | `requireWorktree: false`, with no `start-slice` yet, so no base is pinned. Approve code. | Refused. |
| Staging and committing keep it valid | Approve. Run `git add -A` and `check`. Then run `git commit` and `check`. | Still APPROVED both times. This is finding 4. |
| Real changes make it stale | Separate tests: edit a tracked file; add a new file; delete a file; change a binary file; rename a file. | STALE every time. |
| Working on `main` | `requireWorktree: false`. Approve, then commit a new file on `main`. | STALE. This is finding 5. |
| Commit, then revert the working tree | Approve. Commit an `EVIL` line, then `git checkout HEAD~1 -- file`. `runGuard` with `git push`. | `deny`, with a reason saying HEAD differs from what was approved. |
| Dirty tree at push | Approve. Leave one uncommitted change. `runGuard` with `git push`. | `deny`. |
| Only Dex's own files skipped | After approval, change `docs/dex/feat/04-design.md` and check the code approval. Then add `docs/dex/lib/Evil.java`. Then add `.dex/evil.sh` with `git add -f` and commit it. | Still approved (the design goes stale separately). Then STALE. Then the push is denied. |
| Config roots | Set `artifactRoot` to `.`, `..`, `../x`, `/abs` and `src/../..` in turn. | Each one gives a warning and falls back to the default. |
| `review.js` uses configured roots | `runWorkflow('review.js', { artifactRoot: 'notes', … })`. | The prompts mention `notes/`. None mention `docs/dex`. |
| Verification tied to the tree | Record a pass. Edit a file. Run `check`. | Verification is NOT-RUN. The same test for review. |
| No early verification or review | Run `verification feat pass` with S2 unfinished. The same for `record-review`. | Both refused. |
| `status --review` file list | A feature with a new untracked file, a renamed file, a file under `docs/dexter/`, and a file moved out of `docs/dex/`. Compare the listed files with `git diff --name-only <baseSha> <tree>`. | The two lists are identical. |
| Tree computed only for publishing | Set `DEX_TRACE=1`. `runGuard` with a Write after approval, then with `git push`. | Only the push logs `workTree` to stderr. |
| End-to-end | `tests/e2e.test.mjs`. | Green. |

**Live check:** in `dex-sample`, finish a small feature up to code approval. Then ask Claude to stage and commit. `/dex:status` still shows the code as APPROVED.

**Done when** `tests/e2e.test.mjs` is green.

---

## Step 4: Gate rules

**Fixes:** 8, 12, 20, 21, 35, 36. **Decisions:** Q4, Q5, Q8.

1. **`canImplement` requires all of these:**
   - questions, design and structure approved and not stale;
   - the plan exists;
   - the worktree is ready, if one is required;
   - the feature is not blocked.
2. **`canPr` requires all of these:**
   - everything `canImplement` requires;
   - every checkpoint complete;
   - verification PASS for the current tree;
   - AI review PASS for the current tree, if required;
   - code approval for the current tree, if required.
3. **One-level staleness (Q4).**
   - The design approval stores the questions file's hash.
   - The structure approval stores the design file's hash.
   - If the stored hash no longer matches, the approval shows as STALE.
4. **`strictGates: false` (Q5)** only skips the ordering checks inside `approve` and `set-slices`. Check the two `can*` functions to make sure nothing else reads it.
5. **An approved file that has since been emptied or deleted shows as STALE, not MISSING** (finding 36).
6. **Drift.**
   - `drift` stores the design and structure hashes, and calls `refreshPhase` (finding 35).
   - `unblock` needs a design or structure approval recorded after the drift, and no missing artifacts.
   - `unblock` only resets checkpoints that the drift blocked.
   - The approve hook runs `unblock` automatically after a re-approval, when these conditions hold.
   - `drift` takes `--target design|structure`. `next` points to that command.
   - `--slice` must name a checkpoint that exists.
7. **Checkpoints.**
   - `finish-slice` requires the checkpoint to be in progress and `canImplement` to be true.
   - `set-slices` refuses to drop a recorded checkpoint unless `--replace` is given. It also refuses once any checkpoint has started.
   - Checkpoint ids are normalised to `S<number>`, so `S01` becomes `S1`.
8. **Flags need values.** A flag given without a value is an error, not the string `"true"`. Apply this to all flags, and add a helper in the argument parser.

### How to test step 4

| Change | Test | Expected |
|---|---|---|
| `canImplement` checks | Start from a feature ready to implement. In separate tests: make the questions stale, delete the plan, block the feature. | `canImplement` is false each time, and the reason names the cause. |
| `canPr` checks | Start from a feature ready for a PR. In separate tests: make the design stale, make the structure stale, delete the plan, delete the worktree folder, reopen a checkpoint, change code after verification, change code after review. | `canPr` is false each time, and its blocker list names the cause. `runGuard` with `git push` is denied each time. |
| One-level staleness | Approve everything. Edit the questions and re-approve them. | Design STALE, with the reason "questions changed". Structure still APPROVED. |
| … second level | Then edit the design and re-approve it. | Structure STALE. |
| `strictGates: false` | Set it to `false`. Approve the design before the questions. Then skip the design approval entirely and drive to the PR. | The first approval is allowed. `canPr` is false, naming the design. |
| Emptied file | Approve the design, then empty the file. | STALE, not MISSING. |
| Drift needs re-approval | `drift feat --target design --reason "x"`, then `unblock`. | Refused. |
| … and unblocks after it | `drift`, edit the design, then `runPromptHook('/dex:approve design feat')`. | Approved and unblocked. `next` is `/dex:implement`. |
| Drift target | `drift --target structure`. | `next` is `/dex:structure`. |
| Drift input checks | `drift --slice S9`; `drift --reason` with no value. | Both refused. |
| `unblock` resets only its own checkpoints | Block S2 with `block-slice`. Drift on S1, re-approve. | S1 goes back to pending. S2 stays BLOCKED. |
| Checkpoint rules | In turn: `finish-slice` without start; `finish-slice` while blocked; `set-slices` that drops S2; `set-slices` after S1 started; `set-slices S01 S1`. | All refused. The last is refused as a duplicate, because `S01` becomes `S1`. |
| Flags need values | A table-driven test runs every command's flags with the value missing. | Each one fails with "flag --x needs a value". |

Drift now takes `--target design|structure` instead of guessing from the reason text. Update the implement skill to pass it.

---

## Step 5: The guard understands shell commands

**Fixes:** 13, 14, 15, 16, 26, 27, 40, 41. **Decisions:** Q7, Q12.

1. **New `scripts/shell.mjs`.** It turns a command string into a list of simple commands, each with its words (`argv`) and its redirects. It must handle:
   - quotes and backslashes;
   - heredocs, skipping their bodies;
   - the operators `;` `&&` `||` `|` `&`, newlines and a leading `!`;
   - every redirect form: `>`, `>>`, `>|`, `&>`, `2>`, and redirects with no space before the filename;
   - `$(…)` and backticks, which it looks inside;
   - `sh|bash|zsh -c '…'` and `eval …`, which it also looks inside.

   It uses no npm packages. Test it on its own.
2. **Cleaning up each command's name.**
   - Take the base name and remove quotes and backslashes.
   - Strip wrapper commands together with their flags: `env`, `command`, `sudo`, `timeout`, `stdbuf`, `nice`, `nohup`, `time`, `xargs`.
   - Treat `npx gh` as `gh`.
   - For `git`, skip every global option before the subcommand, and resolve aliases with `git config --get alias.<name>`.
3. **The publish list (Q7):**
   - git: `git push`, `send-pack`, `subtree push`, `send-email`, `request-pull`;
   - GitHub CLI: `gh pr create|merge|ready`, `gh pr edit --ready`, `gh release create`;
   - `gh api` with `-X POST|PUT|PATCH|DELETE`, `-f`, `-F` or `--input`;
   - other hosts: `glab mr create|merge`, `hub push|pull-request`;
   - `curl` or `wget` sending a write method or data to `github.com` or `gitlab` hosts;
   - package and image publishing: `npm|pnpm|yarn publish`, `cargo publish`, `docker push`, `twine upload`, `gem push`.

   Drop the loose patterns that matched `git log --grep send-email` and `git push-to-checkout` (finding 41).
4. **The change list.** Add everything listed in finding 27.

   For finding 26, the parser removes the false matches inside quotes and heredocs. File operations inside `<artifactRoot>` are allowed.

   One default not discussed earlier: saving test or build logs into the repo is still denied. The reason text suggests `$TMPDIR` instead. Change this if you disagree.
5. **Paths.**
   - Resolve each path against the command's own `cwd`, not the repo root.
   - Resolve symlinks on the deepest folder that exists.
   - Deny anything that still escapes the repo.
   - Apply the `/tmp` and `$TMPDIR` exemption only to paths that end up outside the repo.
   - As built: a write that lands outside every checkout Dex knows about (the main checkout and each feature worktree) is allowed. Dex guards the repository, not the rest of the disk.
6. **The matcher.**
   - Widen `hooks.json` to `Write|Edit|MultiEdit|NotebookEdit|Bash|ApplyPatch|PowerShell|Shell|mcp__.*`.
   - For `ApplyPatch`, read the targets from `*** (Add|Update|Delete) File:` lines.
   - For MCP tools, check the common path fields: `path`, `file_path`, `filePath`, `target`.
7. **The "main script" check.** In `guard.mjs` and `state.mjs`, compare `import.meta.url` with `pathToFileURL(realpathSync(process.argv[1])).href`.
8. **The `pre-push` hook (Q12).**
   - New `scripts/pre-push.mjs`, installed by a new command, `state.mjs install-hook`. `/dex:worktree` calls it. (It takes no slug: one hook covers every `dex/*` branch.)
   - For each ref being pushed to `refs/heads/dex/<slug>`, the hook runs the `canPr` check and the tree check from step 3. Any other ref passes.
   - The installer refuses if a `pre-push` hook already exists or `core.hooksPath` is set. In that case it prints the one line to add to the existing hook.
   - `/dex:doctor` reports whether the hook is installed.
9. **Speed.** Set the hook timeout to 30 seconds. Publish commands are the only ones that compute the tree.

### How to test step 5

Most of step 5 is tested with tables: one row per command, all run by the same test loop.

| Change | Test | Expected |
|---|---|---|
| `shell.mjs` | A unit table covering: quotes, escapes, heredocs, each operator, each redirect form, `$(…)`, backticks, `sh -c`, `bash -lc`, `eval`. | Each input gives the expected list of commands and redirects. |
| Publish detection | A table of every command in finding 13 and every item in the Q7 publish list. Run each with `runGuard` twice: before code approval, and after full approval. | `deny` before approval. `allow` after it, except commands that are never allowed. This proves the guard isn't just blocking everything. |
| No false publish matches | `git log --grep send-email`, `git push-to-checkout --help`, `echo "git push"`. | `allow`. |
| Missed changes | A table of every command in finding 27, run during design. | `deny`. |
| False denials | A table of every command in finding 26, run during design. | `allow`, except test logs written into the repo. |
| Paths | A table of every path in finding 14, plus the two cases run from `src/`. | Each one is decided on where the file really lands. |
| Symlink escape | Create `docs/dex/feat/link -> ../../../src`, then Write through it. | `deny`. |
| Matcher | `staticText`: every tool name in the guard's tool sets matches the `hooks.json` matcher. | Pass. |
| ApplyPatch | `runGuard` with a patch containing `*** Update File: src/A.java`, during design. | `deny`. |
| MCP tools | `runGuard` with `mcp__fs__write_file`: first with `path: src/A.java`, then with `docs/dex/feat/x.md`. | `deny`, then `allow`. |
| "Main script" check | Symlink the plugin folder, then run the guard through the link. Copy the plugin into a folder named `a#b` and run it from there. | The guard returns a decision in both cases. It is not silent. |
| `pre-push` hook | Real git with a bare `origin`, after `install-hook`:<br>1. push `dex/feat` before approval;<br>2. push after approval;<br>3. push an unrelated branch. | 1 fails with Dex's message. 2 succeeds. 3 succeeds. |
| … an existing hook | Install with a `pre-push` file already present. Then again with `core.hooksPath` set. | Both refuse, print the line to add, and leave the existing file unchanged. |
| … doctor | Run `doctor` before and after installing. | "not installed", then "installed". |
| Timeout | `staticText`: `hooks.json` sets a 30-second timeout. | Pass. |

**Live checks** in `dex-sample`, in auto mode, before code approval:
- Ask Claude to push. It is denied.
- Ask Claude to "run `sh -c 'git push'`". It is denied.
- Run `git push` yourself in a terminal from the worktree. The `pre-push` hook stops it.

---

## Step 6: Workflows and skills

**Fixes:** 9, 17, 18, 22, 37, 39. **Decisions:** Q3, Q10, Q11.

1. **Paths come in through `args` (finding 9).**
   - The research and review skills pass `stateScript`, `templatesDir`, `artifactRoot` and `stateRoot` in `args`, using the method chosen in step 0.
   - The workflows read these only from `args`, never from `$CLAUDE_PLUGIN_ROOT`.
   - The skills call the Workflow tool with `scriptPath`.
2. **Research covers every question (finding 17).**
   - Research every approved question, including the ones under Human Notes.
   - Run them in batches of `maxResearchWorkers`.
   - Questions that fail are listed in the report and in the result.
3. **Isolation (finding 18).**
   - Probes run with the plugin's read-only `research-probe` agent type. Check whether the workflow `agent()` call accepts an agent type. If it doesn't, give the probes an explicit read-only tool list.
   - The probe prompt tells them to skip `<artifactRoot>/**` and `<stateRoot>/**`.
   - Correct `README.md:404` so it says what is actually enforced.
4. **Review (finding 22).**
   - The skill lists the exact dimension keys from `review.js`.
   - It passes `verification` from `state.mjs check`.
   - The review diff is `<baseSha>..<tree>` from step 3, so new files are included.
5. **Both skills check the result.** If the workflow returns `ok: false`, the skill stops and reports. It does not write the report again, because the workflow already did.
6. **Tracer checkpoint (finding 37).** `set-slices` reads `Tracer bullet required:` from `05-structure.md`. It warns when the checkpoint ids don't match the ones in the structure file.
7. **Tool name (finding 39).** Confirm the current tool name in the docs. If it has changed, replace `Task` with `Agent` in `allowed-tools`.
8. **`/dex:pr` (Q11).**
   - Copy `<artifactRoot>/<slug>/*.md` into the worktree, then add, commit and push.
   - The artifact files are left out of the hash in step 3, so the approval still holds.

### How to test step 6

| Change | Test | Expected |
|---|---|---|
| Paths come in through `args` | `staticText`: no workflow contains `CLAUDE_PLUGIN_ROOT`. `runWorkflow('research.js', { stateScript: '/x/state.mjs', … })`. | Pass. The gate-check prompt contains `/x/state.mjs`. |
| Skills use `scriptPath` | `staticText` on the research and review skills. | Both say `scriptPath`. |
| Every question researched | `runWorkflow` with 8 questions, 2 Human Notes questions and `maxResearchWorkers: 6`. The fake agent counts how many calls are running at the same time. | All 10 questions are in the result. At most 6 run at once. |
| Failed questions listed | The fake agent fails one probe. | That question is in `failedQuestions`, and the synthesis prompt lists it as unanswered. |
| Probes are read-only | Inspect the options passed to the fake agent for each probe. | Each probe has agent type `research-probe`, or a tool list with no write tools. The prompt says to skip `docs/dex/**` and `.dex/**`. |
| Review dimension names | `staticText`: every dimension key the review skill names exists in `review.js`. | Pass. |
| Review gets verification | `runWorkflow('review.js', { verification: {…} })`. | The reviewer prompts contain the verification summary. |
| Review sees new files | `runWorkflow('review.js', …)` in a repo with a new untracked file. | The diff command in the prompt uses `<baseSha>..<tree>`. |
| Failure handling | `staticText`: both skills say to stop when `ok` is false, and not to write the report. | Pass. The live check confirms behaviour. |
| Tracer line read | A structure that says `Tracer bullet required: YES`, with no tracer checkpoint. Then checkpoint ids that don't match the structure file. | `set-slices` warns both times. |
| Tool name | Check the current name in the docs, then `staticText` over `allowed-tools`. | Only current tool names are used. |
| `/dex:pr` includes the documents | Extend `e2e.test.mjs`: copy the artifacts into the worktree, commit, push to the bare `origin`. | The push succeeds. `git ls-tree origin/dex/feat` lists `docs/dex/feat/01-intent.md` and the other files. |

**Live checks** in `dex-sample`, with a real feature from start to finish:
- `/dex:research` writes `03-research.md` once, and it covers every question.
- The transcript shows no probe reading `docs/dex/`.
- `/dex:review` writes `08-review.md` once, and it mentions the verification result.
- Break the research gate on purpose, for example by un-approving the questions. The skill stops and says why, and does not write the report itself.
- `/dex:pr` opens a PR with the documents included. Use a throwaway GitHub repo, or check the pushed branch.

---

## Step 7: Hygiene

**Fixes:** 24, 25, 28, 29, 31, 32, 33, 34.

1. **Secrets (finding 24).**
   - Scrub text before storing it in `state.json` or `events.jsonl`.
   - Scrub before truncating.
   - Add patterns for `*SECRET*=`, `*TOKEN*=`, `*KEY*=`, `*PASSWORD*=`, `-u user:pass`, `-p<password>` and `AIza…`.
2. **Slugs (findings 25, 33, 34).**
   - Every command checks the slug against `^[a-z0-9-]{1,60}$` and rejects anything else. This happens before any folder is touched.
   - `init` refuses a slug that comes out empty after cleaning, instead of falling back to `feature`.
   - `init` also refuses the gate names `questions`, `design`, `structure` and `code`.
3. **`approve` argument order (finding 29).** Accept `approve <gate> <slug>` only.
4. **Locks (finding 28).**
   - An empty lock file is judged by its modification time.
   - A negative age counts as stale.
   - A stale lock is reclaimed by renaming it, then checking again.
   - `init` takes the lock before checking whether the feature exists.
5. **Doctor (findings 31, 32).**
   - It checks whether folders are writable without creating them: test the nearest existing parent.
   - It reports features it cannot read.

### How to test step 7

| Change | Test | Expected |
|---|---|---|
| Secrets | A table of every leaked form in finding 24. Pass each one through `verification --command`, `finish-slice --note` and `drift --reason`. Then search both `events.jsonl` and `state.json` for the secret value. | Found in neither file. |
| Scrub before truncating | A 395-character command that ends in a 40-character token. | No part of the token of 8 or more characters survives. |
| Slug checks | A table of: `../x`, `Foo`, `a/b`, 61 characters, and an empty string, run through `approve`, `status` and `active`. | All refused. No folder is created: check the temp folder's parent before and after. |
| Unicode titles | `init "日本語"`. | Refused, with a hint to give `--slug` or an English title. |
| Reserved slugs | `init code`, then `init design`. | Both refused. |
| Argument order | `approve feat design`. | Refused, with the correct order shown. |
| Empty lock | Create an empty `.lock` with the current modification time, then run a command. Repeat with a modification time 5 minutes old. | The first waits, then fails with "locked". The second reclaims the lock. |
| Future-dated lock | A lock with `acquiredAt` in the future. | Reclaimed. |
| Concurrent `init` | Start two `init feat` processes at the same moment, 20 times. | Exactly one succeeds each time. |
| Doctor writes nothing | Run `doctor` in a repo without `.dex/`. | Still no `.dex/` or `docs/dex/` afterwards. |
| Doctor sees corrupt state | Corrupt one `state.json`, then run `doctor`. | It reports that feature as unreadable, and exits 1. |

---

## Step 8: Documentation

1. `dex/README.md`:
   - how approval works now;
   - what the guard enforces and what it cannot;
   - the `pre-push` hook;
   - that the artifacts are committed with the PR;
   - the `maxResearchWorkers` meaning;
   - the new `state.mjs` commands.
2. `readme.md`, the user manual: update the workflow table, the approval steps, the drift recovery section and the list of things to watch out for.
3. `CHANGELOG.md`: add a new version entry that lists the fixed findings.
4. `review-findings.md`: mark each finding as fixed, with the commit that fixed it.

### How to test step 8

| Change | Test | Expected |
|---|---|---|
| Plugin still valid | `claude plugin validate --strict ./dex`. | Pass. |
| README command list | `staticText`: every folder in `skills/` appears in the README's command table, and nothing else does. | Pass. |
| `state.mjs help` | Every command documented in the README appears in `state.mjs help`. | Pass. |
| Findings file | Every finding from 1 to 30 is marked fixed with a commit hash, and names at least one test. | You check this by reading. |

---

## Release check

Do this after step 8, before calling the work done.

1. `node --test dex/tests/*.test.mjs`. Everything is green, and no test is marked skipped or expected-to-fail.
2. In `dex-sample`, run one small feature through every command, from `/dex:start` to `/dex:pr`, in auto mode. Every live check in `LIVE-CHECKS.md` is ticked with a date.
3. Re-run the three adversarial reviews from the original findings, pointed at the new code. Anything they confirm becomes a new finding, not a silent fix.

---

## Risks

- ~~**Step 0 may rule out the approval hook.**~~ Resolved on 2026-09-28: the hook receives the raw typed text. See `dex/NOTES.md`.
- **Pattern matching will still miss some interpreter tricks,** such as `python -c` writing files. The `pre-push` hook covers publishing to git. Direct file writes by interpreters before implementation starts remain a known gap. The README must say so.
- **Step 3 changes what an approval is.** Done without a format bump: a code approval recorded by the old code has no tree, so it shows as STALE with a note to read the diff and approve again.
