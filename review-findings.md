# Dex Review Findings

**Date:** 2026-09-27

## Summary

The gates can be bypassed, and the normal happy path breaks twice.

**The gates can be bypassed.** Any one of these three is enough for the model to get past every gate:
- The model can approve its own work.
- The model can rewrite the state files the gates read.
- The model can run commands from inside the worktree, where Dex finds no feature and checks nothing.

**The normal happy path breaks** even when nobody tries to cheat:
- `/dex:worktree` always stops on its own "uncommitted changes" check.
- `/dex:pr` makes its own code approval stale, so its push is refused.

The existing suite passes: 123 tests, 0 failures. None of the problems below has a test.

**How to read this file.**
- Findings are ordered by severity.
- **Confirmed** means a reviewer reproduced it by running the scripts in a throwaway git repo.
- **Suspected** means it came from reading the code and was not run.
- Each finding lists the files involved, what goes wrong, a fix, and the test to add.
- Paths are relative to `dex/`.

Fix the critical findings 1 to 3 first. Most of the pattern fixes further down matter little until those three are closed.

---

## Critical

### 1. The model can approve its own work
**Confirmed.** `scripts/guard.mjs`, `scripts/state.mjs`, `skills/approve/SKILL.md`

`/dex:approve` is marked user-only, but nothing stops the model from running the script behind it. A Bash call to `node scripts/state.mjs approve <slug> code` is allowed. It prints "APPROVED: human code review", and `git push` then goes through. The same works for `design` and `structure`.

- **Fix:** Make approval a step only a human can take. Options:
  - The guard returns `permissionDecision: "ask"` for any Bash call to `state.mjs approve`. Do the same for `unblock`, `record-review`, `verification`, `active` and `drift`.
  - Or record approvals only from a `UserPromptSubmit` hook, which sees `/dex:approve` typed by the user.
- **Test:** A Bash call to `state.mjs approve <slug> code` is not silently allowed.

### 2. The model can rewrite the state the gates read
**Confirmed.** `guard.mjs:164,178,316`, `tests/guard.test.mjs:105`

The guard allows writes to `.dex/**` in every phase, and a test locks that in. Two examples:
- Writing `{"requireHumanCodeApproval":false}` to `.dex/config.json` turns a denied `git push` into an allowed one.
- Rewriting `.dex/<slug>/state.json` to `"phase":"abandoned"` unlocks production edits during design.

Setting `artifactRoot: "src"` in the config makes every production file count as an "artifact".

- **Fix:** Allow edit tools and shell redirects to write only under `docs/dex/**`. Deny them for `.dex/**`; only `state.mjs` should write there. Invert the test at `guard.test.mjs:105`.
- **Test:** Write, Edit and `echo … >` into `.dex/config.json` and `.dex/<slug>/state.json` are denied.

### 3. Dex switches off inside the worktree
**Confirmed.** `lib.mjs:124-144` (`findRepoRoot`), `guard.mjs:378`, `skills/implement/SKILL.md:51`, `skills/verify/SKILL.md:25`, `skills/worktree/SKILL.md:48`

`findRepoRoot` uses `git rev-parse --show-toplevel`. Inside a worktree, that returns the worktree's own root. The worktree has no `.dex/` folder, so no feature is found.

What happens then:
- `state.mjs check <slug>` says "no feature named …". So `start-slice`, `finish-slice` and `verification` fail.
- The guard allows `git push` and `gh pr create` from there. With the working directory at the repo root, both are denied.

The worktree skill recommends Claude Code's built-in worktree, which moves the whole session into the worktree. So this is the default path, not an edge case.

- **Fix:** In `findRepoRoot`, resolve the main checkout with `git rev-parse --path-format=absolute --git-common-dir` and take its parent. Have skills use `git -C <worktree>` instead of `cd`. Drop the built-in worktree suggestion, or handle it.
- **Test:** Run `state.mjs check` and the guard with the working directory set to a linked worktree. Expect the feature to be found and a push denied.

### 4. `/dex:pr` makes its own code approval stale
**Confirmed.** `skills/pr/SKILL.md:50-53`, `lib.mjs:724-768` (`diffFingerprint`)

The code approval is a hash of two things: `git diff <base>` and the list of untracked files. `/dex:pr` runs `git add -A` first. That turns new files from untracked into tracked, which changes the hash. The approval goes STALE and the guard refuses the push. The PR can never go out as written.

- **Fix:** Make the hash the same whether files are untracked, staged or committed. For example, build it from a temporary index: `GIT_INDEX_FILE=tmp git add -A && git diff --cached <base>`.
- **Test:** Approve code, then `add`, `commit` and `push` in the worktree. The push is allowed.

### 5. What gets pushed is not what was approved
**Confirmed.** `lib.mjs:724-760`, `state.mjs:610,1030`

The hash compares the base with the working tree, not with the commit being pushed. Four ways this goes wrong:
- **Revert after committing.** Commit a bad change, then revert only the file on disk. The working tree matches the approval, so the push is allowed while HEAD holds the bad change.
- **Base is HEAD.** Working on `main` with `requireWorktree: false` makes the base `main`, which is HEAD. Any new commit is invisible, so the approval stays valid.
- **No base found.** With no `main`, `master` or `origin`, the base is empty and only unstaged changes are hashed. Staged changes are invisible.
- **`--base HEAD` is accepted.** `record-worktree … --base HEAD` has the same effect as the base-is-HEAD case.

`git push origin <any-ref>:<branch>` is not limited either.

- **Fix:** At approval, pin the base to a commit SHA (`git merge-base <base> HEAD`). Store HEAD's SHA with the approval. At push time, hash `base..HEAD` and require a clean working tree. Refuse to approve when there is no base or when the base equals HEAD.
- **Tests:** Each of these makes the approval stale or blocks the push:
  - commit then revert the working tree;
  - a new commit on `main` after approval;
  - staged changes with no base.

  `--base HEAD` is refused.

### 6. Code can hide from review in the Dex folders
**Confirmed.** `lib.mjs:728-732`, `lib.mjs:361-366` (config validation)

The code hash skips everything under `docs/dex/**` and `.dex/**`, not just Dex's own markdown files. Examples:
- `docs/dex/Backdoor.java` or `.dex/postinstall.sh`, committed after approval, is pushed without review.
- With `artifactRoot: "."`, nothing is ever hashed.
- With `stateRoot: "../outside"`, Dex writes outside the repo. The config only rejects absolute paths.

- **Fix:** Skip only the known artifact files in `<artifactRoot>/<slug>/`. Reject roots that contain `..`, that are `.`, or that resolve outside the repo.
- **Test:** A `.java` file under `docs/dex/` changes the hash. `artifactRoot: "."` and `"../x"` are rejected.

### 7. A corrupt state file turns every gate off
**Confirmed.** `lib.mjs:248-253` (`readJson`), `guard.mjs:269`, `guard.mjs:424-439`

`readJson` returns its fallback for invalid JSON as well as for a missing file. So a truncated `state.json` makes the feature disappear. `list` then says "No Dex features", and the guard allows production writes and `git push`.

Malformed config or state, such as `[]`, also crashes the guard. It then fails open for everything except a plain `git push`, and `sh -c "git push"` still gets through. Finding 2 lets the model create either situation itself.

- **Fix:** Return the fallback only when the file is missing. Throw on a parse error. When a feature folder exists but cannot be read, the guard denies all changes instead of allowing them.
- **Test:** Corrupt `state.json`, then check that a Write to `src/`, `git push` and `sh -c "git push"` are all denied.

### 8. The PR gate does not re-check design, structure, plan or worktree
**Confirmed.** `state.mjs:227-242` (`canPr`)

Take a feature ready for a PR. Edit the design and the structure, and delete the plan and the worktree. `check` shows design and structure as STALE, yet `canPr` is still true and `git push` is allowed. The same staleness does block code edits.

With `strictGates: false`, a PR can go out with no design or structure approval at all.

- **Fix:** Make `canPr` require everything `canImplement` requires, plus approved questions.
- **Test:** Each of these blocks `canPr`: a stale design, a stale structure, a missing plan, a missing worktree.

### 9. Research fails on every run
**Confirmed by the Claude Code docs.** `workflows/research.js:177,369`, `workflows/review.js:402`

The workflows run `node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs"` inside agent shells. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in skill text. The docs say it is not exported to commands run through the Bash tool, by the main session or by subagents. An `echo` test agreed. So the path becomes `/scripts/state.mjs`, the gate check fails, and research returns `ok: false` every time. The skill then does not say what to do (see finding 22).

- **Fix:** Have the skills pass `stateScript` and `templatesDir` in the workflow's `args`. Paths in skill text arrive already resolved.
- **Test:** A static check that no workflow reads `$CLAUDE_PLUGIN_ROOT` except through `args`.

---

## High

### 10. `/dex:worktree` always stops on its own check
**Confirmed.** `skills/worktree/SKILL.md:26-33`

After `/dex:start`, `git status --porcelain` always shows `?? .dex/` and `?? docs/`. The skill says to stop when the tree has uncommitted changes, so every run stops.

- **Fix:** Ignore Dex's own folders in that check. Or have `init` add `.dex/` to `.git/info/exclude`.
- **Test:** A fresh `init`, then the worktree precondition, passes.

### 11. Verification and AI review are not tied to the code they checked
**Confirmed.** `state.mjs:906-1010`

Record a passing verification. Then replace `src/a.js` with broken code and record a passing review. Verification still shows PASS, and the PR is allowed.

- **Fix:** Store the code hash with each verification and review result. Treat a result as NOT-RUN when the hash no longer matches.
- **Test:** Change code after a passing verification. Verification is no longer PASS.

### 12. Implementation can start while the questions approval is stale
**Confirmed.** `state.mjs:219-225` (`canImplement`)

After everything is approved, edit `02-questions.md`. `check` shows questions as STALE and `next` says to re-approve them. But `canImplement` is still true.

- **Fix:** Add "questions approved" to `canImplement`.
- **Test:** Stale questions block `canImplement`.

### 13. `git push` detection is easy to bypass
**Confirmed.** `guard.mjs:47-55` (publish patterns), `guard.mjs:141-150` (`stripPrefixes`)

All of these were allowed when a push should have been denied:
- **git options before `push`:** `git --no-pager push`, `git --git-dir=.git push`, `git -Cfoo push`
- **a path or quotes on the command:** `/usr/bin/git push`, `\git push`, `'git' push`, `git pu""sh`
- **wrappers with flags:** `env -i git push`, `sudo -u me git push`, `timeout 30 git push`, `xargs -n1 git push`
- **other separators:** `true & git push`, `! git push`
- **nested shells and interpreters:** `sh -c "git push"`, `bash -lc '…'`, `eval git push`, `python3 -c "os.system('git push')"`, `make push`
- **aliases and plumbing:** `git config alias.p push && git p`, `git subtree push`, `git send-pack`
- **GitHub CLI and API:** `gh api repos/o/r/pulls -f …`, `gh -R o/r pr create`, `npx gh pr create`, `curl -X POST https://api.github.com/…/pulls`

- **Fix:** Split commands with a real shell-word parser. Strip wrappers together with their flags. Skip any git global option. Match on the command's base name with quotes removed. Look inside `sh|bash|zsh -c` and `eval`. Treat `gh api` with `-X POST|PATCH|PUT` or `-f/-F` as publishing. Pattern matching cannot stop an interpreter, so for real protection add a git `pre-push` hook that runs the `canPr` check.
- **Test:** One case per bullet above.

### 14. Paths with `..` or symlinks get past the edit check
**Confirmed.** `lib.mjs:99-116` (`normalizeRelPath`), `guard.mjs:162`

All of these were allowed during design:
- a Write to `docs/dex/../src/A.java`
- a Write to `<root>/.dex/../src/A.java`
- a Write through a symlink `docs/dex/feat/link -> ../../../src`
- a redirect to `/tmp/../<root>/src/A.java`

The `/tmp` exemption is checked before the path is cleaned up. So any repo that lives under `/tmp` is fully exempt.

Relative paths are resolved against the repo root instead of the shell's working directory. So `> ../docs/dex/x` from `src/` is wrongly denied. And `> docs/dex/x` from `src/` writes `src/docs/dex/x` and is wrongly allowed.

- **Fix:** Resolve the path against the working directory. Resolve symlinks on the deepest existing parent folder. Deny anything still outside the repo. Apply the scratch-folder exemption only after resolving.
- **Test:** One case per bullet, plus the two cases from `src/`.

### 15. Tools outside the hook's matcher are never checked
**Confirmed.** `hooks/hooks.json:5`, `guard.mjs:36-37`

The matcher is `Write|Edit|MultiEdit|NotebookEdit|Bash`. The guard's code knows `ApplyPatch`, `PowerShell` and `Shell`, but the hook never fires for them. MCP tools that write files, such as `mcp__filesystem__write_file`, are also unchecked. Even when given to the guard directly, `ApplyPatch` and `PowerShell Set-Content` are allowed.

- **Fix:** Widen the matcher to include `ApplyPatch|PowerShell|Shell|mcp__.*`, or use `.*`. Read the file targets from `*** Add|Update|Delete File:` lines in patches.
- **Test:** Every tool name in the guard's tool sets matches the hook matcher.

### 16. The guard does nothing when the plugin path has a symlink, `#` or `%`
**Confirmed.** `guard.mjs:409`, `state.mjs:1230`

The "am I the main script?" check compares `argv[1]` with `import.meta.url`. Through a symlinked plugin folder, or a path containing `#` or `%`, the two differ. The guard then exits with no output, which counts as "allow".

- **Fix:** Compare `import.meta.url` with `pathToFileURL(fs.realpathSync(process.argv[1])).href`. Or use a small entry file with no check.
- **Test:** Run the guard through a symlink. A design-phase write to `src/` is denied.

### 17. Research silently drops questions past the sixth
**Confirmed.** `workflows/research.js:238`, `skills/questions/SKILL.md:65`, `README.md:416`

The questions skill asks for 6–12 questions. Research runs only the first `maxResearchWorkers` (default 6). The rest appear only in a log line. They are missing from the report, from `failedQuestions`, and from the returned result. The README says they are "listed as unanswered".

Questions a human adds under "Human Notes" are parsed and then dropped (`research.js:52,220`).

- **Fix:** Research every question and use `maxResearchWorkers` to limit how many run at once. Include Human Notes questions.
- **Test:** With 8 questions and a limit of 6, all 8 appear in the result.

### 18. Research isolation is instructed, not enforced
**Confirmed.** `workflows/research.js:257-270`, `README.md:404`

Probes have default tools. A plain search for a domain word will find `docs/dex/<slug>/01-intent.md` and `04-design.md`, and older features' files. The README says research agents "have no write tools at all". On the workflow path that is false.

- **Fix:** Use a read-only agent type for probes, and tell them to skip `docs/dex/**` and `.dex/**`. Correct the README to say what is actually enforced.
- **Test:** The workflow gives probes an agent type or a tool list, and that list has no write tools.

### 19. Most commands never set the active feature
**Confirmed by reading the code.** `guard.mjs`, `state.mjs`

The guard checks only the feature named in `.dex/active`. Only `init`, `transition` and `active` write that file. So `/dex:implement B` or `/dex:pr B`, run while feature A is active, is checked against A's state. That can wrongly allow B's edits and push, or wrongly refuse them.

With two active features, a stale `.dex/active` allows everything, including `rm -rf src`.

- **Fix:** Every command that takes a slug and changes something sets the active feature. When the active feature can't be resolved, deny changes.
- **Test:** Switching between two features gates each one against its own state.

---

## Medium

### 20. After drift, unblocking needs no re-approval, and no command does it
**Confirmed.** `state.mjs:1100-1124`, all skills

"Drift" is when the code contradicts the design during implementation. It marks the feature blocked.

Problems with getting out of that state:
- `drift` followed at once by `unblock` succeeds with nothing re-approved.
- Deleting the design file also lets `unblock` succeed.
- No skill runs `unblock`. The drift message prints `node state.mjs unblock` without the plugin path.
- Until someone unblocks, `next` always points to `/dex:design`, even when only the structure needs work.

Smaller problems:
- `drift --reason` with no value records "true".
- `drift --slice S9` is accepted for a checkpoint that doesn't exist.
- `unblock` resets unrelated blocked checkpoints.

- **Fix:** Store the design and structure hashes when drift is recorded. `unblock` then requires an approval newer than the drift and no missing artifacts. Run `unblock` from `/dex:approve` after a re-approval. Check that the checkpoint id exists.
- **Test:** `drift` then `unblock` is refused. `drift`, re-approve, then `unblock` succeeds.

### 21. Checkpoint recording has no rules
**Confirmed.** `state.mjs:753-904`

A checkpoint is one of the S1, S2, … steps from the structure.

- `finish-slice` works without `start-slice`, without `canImplement`, and while the feature is blocked.
- `finish-slice --verification` with no value records "true".
- `set-slices` can shrink the list. With S1 done, re-recording only S1 made implementation COMPLETE and dropped S2 and S3.
- `S01` and `S1` are accepted as different checkpoints.

- **Fix:**
  - `finish-slice` requires an in-progress checkpoint, `canImplement`, and a real value.
  - `set-slices` refuses to drop recorded checkpoints unless `--replace` is given.
  - Normalise checkpoint ids to `S<number>`.
- **Test:** One case per bullet.

### 22. Research and review skills ignore failures and write reports twice
**Suspected.** `skills/research/SKILL.md:31,61`, `skills/review/SKILL.md:43-44,62`, `workflows/review.js:39,143-147,213`

Both workflows write their report file themselves. The skills then tell Claude to write it again. Neither skill says what to do when the workflow returns `ok: false`.

The review path has three more problems:
- **Wrong parameter name.** The skills say to pass the file as `script`. The Workflow tool expects `scriptPath` for a file (confirmed).
- **Dimension names don't match.** The review skill names dimensions in prose, such as "design and structure conformance". `review.js` expects keys such as `design-conformance`. Prose names fall back to a generic brief.
- **Missing evidence.** The skill never passes `verification`, so every review says no evidence was supplied.
- **New files are hidden.** The review diff (`git diff <base>`) leaves out new, uncommitted files. Reviewers never see their contents.

- **Fix:**
  - The skills check `result.ok` and stop on failure, and do not rewrite the report.
  - Use `scriptPath`.
  - List the exact dimension keys in the review skill.
  - Pass `verification` from `check`.
  - Include untracked files in the review diff.
- **Test:** Check that every dimension named in the review skill is a key in `review.js`.

### 23. Turning `requireWorktree` on or off after `/dex:start` does nothing
**Confirmed.** `lib.mjs:582` (`newFeatureState`), `state.mjs:186,1012-1041`, `skills/worktree/SKILL.md:21`

The setting is copied into the feature when it is created, and never read again. The worktree skill tells Claude to read the live config, so the skill and the gate disagree.

`record-worktree` also accepts any existing path, including `/tmp` or the main checkout, and any branch name.

- **Fix:** Read `requireWorktree` from the live config in the gate check. Check that the recorded path appears in `git worktree list`, is not the main checkout, and is on the named branch.
- **Test:** Changing the config after `init` changes the gate. `record-worktree <slug> main .` is refused.

### 24. Secrets leak into the event log and into `state.json`
**Confirmed.** `lib.mjs:467-482`, `state.mjs:863-866,930-959,1075`

These reached `events.jsonl` unredacted:
- `AWS_SECRET_ACCESS_KEY=…`
- `curl -u admin:hunter2`
- `mysql -phunter2`
- a Google `AIza…` key

`state.json` stores commands, summaries, notes and drift reasons without any scrubbing. Text is cut to 400 characters before it is scrubbed, so a token cut short can slip under the minimum length and survive.

- **Fix:**
  - Scrub before storing anything in state.
  - Scrub before truncating.
  - Add patterns for:
    - `*SECRET*=` / `*TOKEN*=` / `*KEY*=` / `*PASSWORD*=`
    - `-u user:pass`
    - `-p<password>`
    - `AIza…`
- **Test:** One case per leaked form above, checked in both `events.jsonl` and `state.json`.

### 25. A slug containing `..` reaches the filesystem
**Confirmed.** `state.mjs:496`, `lib.mjs:396`

Only `init` cleans the slug. `approve ../../escaped design` fails, but only after creating a folder outside the repo. `status ../.dex/foo` reads a real feature through the path.

- **Fix:** Check every slug against `^[a-z0-9-]{1,60}$` and reject anything else.
- **Test:** `approve ../x design` fails and creates nothing.

### 26. The guard refuses harmless commands during design
**Confirmed.** `guard.mjs:61-115` and the command splitter

- **Test and build logs:** saving a log into the repo is denied, e.g. `npm test > test-output.log` or `mvn test 2>&1 | tee build.log`. Running tests is supposed to be allowed.
- **`>` inside quotes or conditions:** `echo 'a > b'`, `awk '$1 > 3' f` and `[[ 3 > 2 ]]` are denied.
- **Heredocs:** writing an artifact with `cat > docs/dex/…/04-design.md <<'EOF'` is denied when a body line starts with `rm` or `git push`. So is `git commit -m "docs; rm stale notes"`.
- **Checkpoint names:** a name with ` > `, such as `set-slices … "S1:create > persist"`, is denied.
- **Artifact folder:** `cp`, `mv` and `rm` inside `docs/dex/**` are denied.

- **Fix:** Use a real shell parser that understands quotes and heredocs. Allow file operations inside the artifact folder.
- **Test:** One case per bullet.

### 27. The guard misses many ways to change files during design
**Confirmed.** `guard.mjs:61-115`

Allowed during design:
- **git subcommands:**
  - `git -C . reset --hard`, `git --no-pager commit`
  - `git switch`, `git pull`, `git checkout -f`, `git checkout HEAD~1 f`
  - `git stash -u`, `git branch -f`
- **file commands:** `touch`, `mkdir`, `chmod`, `install`, `rsync`, `unlink`, `/bin/rm`, `\rm`
- **in-place editors and formatters:** `sed --in-place`, `prettier --write`, `eslint --fix`, `gofmt -w`, `cargo fmt`, `black`
- **redirect forms:** `echo x>f` (no space), `&>f`, `>|f`, `tee --append=f`
- **interpreters:** `python -c`, `node -e`

The code comments accept some misses. But several of these differ from a blocked command by one token.

- **Fix:** Covered mostly by the parser in finding 13. Add the listed commands and forms.
- **Test:** One case per item.

### 28. Lock handling has gaps
**Confirmed except where noted.** `lib.mjs:400-423`

- An empty lock file is treated as stale and deleted at once. An empty file is what exists between creating the lock and writing to it.
- A lock stamped in the future is never reclaimed.
- Two processes that both see a stale lock can both take it. **Suspected.**
- `init` checks whether the feature exists before taking the lock (`state.mjs:500-511`). **Suspected.**

- **Fix:** Judge an empty lock by its file modification time. Treat a negative age as stale. Reclaim a lock by renaming it, then check again.
- **Test:** An empty fresh lock is respected. A future-dated lock is reclaimed.

### 29. `approve` gets confused when a feature has a gate's name
**Confirmed.** `state.mjs:576-584`

`approve` accepts its two arguments in either order. With features named `code` and `design`, `approve code design` approved the code gate of feature "design".

- **Fix:** Accept one order only. Also refuse gate names (`questions`, `design`, `structure`, `code`) as slugs in `init`.
- **Test:** `init code` is refused.

### 30. The diff-reading guide shows a different diff from what gets approved
**Confirmed.** `status.mjs:34-61,139`

- With no worktree recorded, `status --review` shows only unstaged changes, while `approve` compares against `main`.
- The prefix check hides `docs/dexter/x.js`.
- A file renamed out of `docs/dex/` is hidden.
- The guide is shown before the AI review has passed, although `skills/status/SKILL.md:21` says it waits for that.

- **Fix:** Work out the base the same way `approve` does. Use proper path checks on both sides of a rename. Add the AI-review condition.
- **Test:** The files listed by `status --review` match the files covered by the code hash.

---

## Low

- **31. Doctor writes to the repo.** It creates `.dex/` and `docs/dex/` in any repo it inspects, and follows a `..` config outside it. **Confirmed.** `doctor.mjs`
- **32. Doctor misses corrupt state.** It reports "Features: none yet" when a `state.json` is corrupt. **Confirmed.**
- **33. Unicode slugs collide.** `init "日本語"` and `init "中文"` both become `feature`. **Confirmed.**
- **34. Mixed-case slugs don't resolve.** They are lowercased only at `init`, so `status Foo` fails. **Confirmed.**
- **35. `drift` leaves the phase out of date.** It does not call `refreshPhase`. **Confirmed.**
- **36. An emptied approved file shows MISSING, not STALE.** No stale warning appears. **Confirmed.**
- **37. The structure's tracer line is never read.** `Tracer bullet required:` in the structure file is never parsed. The tracer is guessed from the word "tracer" in the checkpoint name. Nothing checks that checkpoint ids match the structure. **Confirmed.**
- **38. Roots are hard-coded in two places.** `review.js` uses `docs/dex` and `.dex` instead of the configured roots. `loadConfig` always reads `.dex/config.json` even when `stateRoot` differs. **Confirmed.**
- **39. Old tool name in skills.** Several skills list `Task` in `allowed-tools`; the subagent tool is now called `Agent`. **Suspected.**
- **40. The hook fails open when it is slow.** After code approval, every checked call runs `git diff` and hashes all untracked files. The hook timeout is 15 s. A timeout, or `node` missing from PATH, fails open, push included. **Suspected.** `state.mjs:136-154`
- **41. False publish matches.** `git log --grep send-email` and `git push-to-checkout` match the publish patterns. **Confirmed.**

---

## Missing tests

`tests/workflow.test.mjs` checks the workflow files only as text. Nothing runs them. Beyond the per-finding tests above, add:

- a check that every `state.mjs` command and flag used in a skill or workflow exists in `state.mjs`;
- guard tests with the working directory set to a linked worktree, a subfolder, and a nested repo;
- an end-to-end run of the documented flow in a temporary repo: start, approvals, worktree, one checkpoint, verify, review, code approval, add, commit, push. Findings 3, 4 and 10 would each have failed it.

---

## Open questions

These need a decision from you before some fixes can be made.

1. **Trust boundary.** Should the model be physically unable to record an approval or edit `.dex/`? Or is an instruction enough? Findings 1, 2 and 7 depend on this. The README's "enforced with a program" claim implies the former.
2. **Where commands run.** Should everything run from the main checkout? Or should Dex state be reachable from the worktree? This decides the fix for finding 3.
3. **Built-in worktrees.** Are Claude Code's built-in worktrees supported? They live inside the repo and move the session there, which breaks the skill's own "outside the repo" rule.
4. **The research limit.** Is `maxResearchWorkers` a limit on how many questions run at once, or on how many get researched? (Finding 17.)
5. **Cascading staleness.** Should re-approving the questions make the design and structure approvals stale? Should each approval record the hashes of the files it was built on?
6. **What `strictGates: false` allows.** Is it meant to allow a PR with no design or structure approval? Today it effectively does (finding 8).
7. **Working on `main`.** Is working directly on `main` without a worktree supported? If yes, finding 5 needs a fix, not a warning.
8. **What counts as publishing.** Only git push and PR creation? Or also `gh api`, `curl` to the GitHub API, `npm publish` and `gh release`?
9. **Checking evidence.** Should `verification` and `record-review` refuse to run before implementation is complete?
10. **Committing artifacts.** Should `docs/dex/` be committed, and on which branch? Today artifacts stay in the main checkout and never reach the PR.
11. **Manifest validity.** Answered: `claude plugin validate --strict` passes, and both fields are documented as valid.
