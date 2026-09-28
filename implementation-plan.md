# Dex Fix Plan

**Date:** 2026-09-27

This plan fixes findings 1–30 in `review-findings.md`. It also fixes the Low findings wherever they touch code a step already changes.

The plan is split into nine steps, numbered 0 to 8. Each step follows the same order:
1. Write the tests first.
2. Make the change.
3. Run the full suite: `node --test dex/tests/*.test.mjs`.
4. Commit.

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

**Done when** `NOTES.md` answers both questions and the two new test files exist. `e2e` is red. `skills-cli` is green, or red for known reasons.

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
   - `--base` must resolve to a commit that is not the worktree's HEAD.

**Tests:**
- `state.mjs check` and the guard with `cwd` set to the worktree, and to a subfolder of it.
- `.dex/` does not appear in `git status` after `init`.
- The worktree precondition passes right after `init`.
- Changing the config after `init` changes the worktree gate.
- `record-worktree <slug> main .` is refused.

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

**Tests:**
- The model's `state.mjs approve` is denied.
- Writes to `.dex/config.json` and `.dex/<slug>/state.json` are denied, by Write, Edit, `echo >`, `cp` and `rm`.
- A corrupt `state.json` denies Write to `src/`, `git push` and `sh -c "git push"`.
- The approve hook records the approval for a matching prompt, ignores others, and ignores extra words after the slug.
- Two features, each checked against its own worktree.

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

**Tests:** each case in findings 4, 5, 6, 11 and 30, plus:
- approve, then add, then commit: still approved;
- `artifactRoot: "."` is rejected;
- `status --review` lists exactly the files that differ in the hashed tree.

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
   - `next` points to `/dex:structure` when only the structure was named in the drift reason. Otherwise it points to `/dex:design`.
   - `--slice` must name a checkpoint that exists.
7. **Checkpoints.**
   - `finish-slice` requires the checkpoint to be in progress and `canImplement` to be true.
   - `set-slices` refuses to drop a recorded checkpoint unless `--replace` is given. It also refuses once any checkpoint has started.
   - Checkpoint ids are normalised to `S<number>`, so `S01` becomes `S1`.
8. **Flags need values.** A flag given without a value is an error, not the string `"true"`. Apply this to all flags, and add a helper in the argument parser.

**Tests:** one per bullet, plus:
- the path through drift, re-approval, automatic unblock, and `next`;
- `strictGates: false` still blocks a PR when there is no design approval.

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
6. **The matcher.**
   - Widen `hooks.json` to `Write|Edit|MultiEdit|NotebookEdit|Bash|ApplyPatch|PowerShell|Shell|mcp__.*`.
   - For `ApplyPatch`, read the targets from `*** (Add|Update|Delete) File:` lines.
   - For MCP tools, check the common path fields: `path`, `file_path`, `filePath`, `target`.
7. **The "main script" check.** In `guard.mjs` and `state.mjs`, compare `import.meta.url` with `pathToFileURL(realpathSync(process.argv[1])).href`.
8. **The `pre-push` hook (Q12).**
   - New `scripts/pre-push.mjs`, installed by a new command, `state.mjs install-hook <slug>`. `/dex:worktree` calls it.
   - For each ref being pushed to `refs/heads/dex/<slug>`, the hook runs the `canPr` check and the tree check from step 3. Any other ref passes.
   - The installer refuses if a `pre-push` hook already exists or `core.hooksPath` is set. In that case it prints the one line to add to the existing hook.
   - `/dex:doctor` reports whether the hook is installed.
9. **Speed.** Set the hook timeout to 30 seconds. Publish commands are the only ones that compute the tree.

**Tests:**
- every bypass listed in findings 13 and 27;
- every false denial listed in finding 26;
- every path case in finding 14;
- each tool the guard knows appears in the matcher;
- the guard works when run through a symlinked plugin folder;
- the `pre-push` hook blocks an unapproved `dex/*` push and allows an unrelated branch.

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

**Tests:**
- the skill-to-CLI test from step 0 is green;
- the research result includes every question, with 8 questions and a limit of 6;
- every dimension named in the review skill is a key in `review.js`;
- no workflow reads `$CLAUDE_PLUGIN_ROOT`.

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

**Tests:** one per bullet.

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

---

## Risks

- **Step 0 may rule out the approval hook.** If the message-submit hook can't see what you typed, approval moves to your own terminal only. That is safe, but adds friction.
- **Pattern matching will still miss some interpreter tricks,** such as `python -c` writing files. The `pre-push` hook covers publishing to git. Direct file writes by interpreters before implementation starts remain a known gap. The README must say so.
- **Step 3 changes what an approval is.** Approvals recorded before the upgrade will show as STALE. Bump `schemaVersion` to 2 and have `state.mjs` explain this, rather than refusing to load old state.
