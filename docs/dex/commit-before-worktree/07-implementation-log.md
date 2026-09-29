# Implementation Log: Commit before worktree

> Appended once per checkpoint. Concise: this is the compaction artifact a fresh
> context reads instead of replaying the whole session.

## S1: Guard commit refusal names the way out

Status: IMPLEMENTED

### Changes

- `guard.mjs` `decide()`: the `change.kind === 'command'` denial adds one
  paragraph when `change.what === 'git commit'`. It tells the user to run
  `! git commit …` themselves. The decision is unchanged.
- `guard.test.mjs`: two tests.
  - Commit variants (`-am`, `--amend`, `-C sub`) in the worktree phase, and a
    commit in the design phase, are denied, and each message contains the line.
  - `rm -rf src` and `git merge main` are denied without it.

### Files

- `dex/scripts/guard.mjs`, `dex/tests/guard.test.mjs`

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 298 pass, 0 fail. The worktree-phase refusal was printed by hand. It shows
the new line above `Next: /dex:worktree feat`.

### Divergence from plan

None.

### New discoveries

None.

### Follow-up risk

- The line reaches the user only if the model relays the refusal. S2 (the skill)
  is the dependable path.

## S2: Worktree skill offers two choices

Status: IMPLEMENTED

### Changes

- Worktree skill, step 2: the bare "stop and ask" is replaced. The skill lists the
  changes, says they will not be in the worktree, and offers "Continue without
  them" or "Commit them first". The second choice prints
  `! git commit -m "<message>" -- "<path>" …` for the user and stops. The skill
  also says "Never run the commit yourself", and keeps the no-stash, reset,
  checkout, or clean rule. The `git status --porcelain` line is unchanged, so
  `repo-root.test.mjs` still finds it.
- `workflow.test.mjs`: one static test pins those four points.
- CHANGELOG `0.2.2` entry. `plugin.json` version set to `0.2.2`.

### Files

- `dex/skills/worktree/SKILL.md`, `dex/tests/workflow.test.mjs`,
  `dex/CHANGELOG.md`, `dex/.claude-plugin/plugin.json`

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 299 pass, 0 fail. This includes `repo-root.test.mjs` and the version and
changelog match.

### Divergence from plan

- The static test reads the raw file, not `skillProse()`. That helper may strip
  code blocks, and the printed commit line is in one.

### New discoveries

None.

### Follow-up risk

- The skill is only tested by its text. Real behaviour shows up the next time a
  feature reaches `/dex:worktree` with a dirty tree.

## Review remediation (after S2)

Status: IMPLEMENTED, with the human's agreement. It stays within S2's approved
scope (the skill's wording), so no checkpoint was added.

### Changes

- AI review HIGH: the printed `git commit -- <path>` failed for new files ("did
  not match any file(s) known to git"). The template is now
  `! git add -- "<new path>" && git commit -m "<message>" -- "<path>" …`. `git add`
  gets only untracked (`??`) paths, and is left out when there are none.
  `git commit --` gets every listed path, both sides of a rename.
  - Found while testing: `git add` of a rename's old path fails ("pathspec did
    not match any files"), because `git mv` has already staged it. That is why
    only untracked paths are added.
- AI review MEDIUM and LOW (test gaps): the skill test now also checks "then
  stop", the "will not be in the new worktree" warning, the "run
  `/dex:worktree <slug>` again" instruction, and the full quoted template.
- New behavioural test in `repo-root.test.mjs`. It fills the template from the
  skill file and runs it against a modified, a new, a deleted, and a renamed file
  with spaces in its name. `git status` is then clean.

### Files

- `dex/skills/worktree/SKILL.md`, `dex/tests/workflow.test.mjs`, `dex/tests/repo-root.test.mjs`

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 300 pass, 0 fail.

### Follow-up risk

- Review LOW (the hint is lost when a commit is not the first refused step of a
  chained command) remains open by decision.

## Review remediation, second round

Status: IMPLEMENTED, with the human's agreement. It stays within S1 and S2 scope.

### Changes

- Review MEDIUM (session started in a subfolder): the printed line now starts
  with `cd "$(git rev-parse --show-toplevel)" &&`, because `git status` paths
  are relative to the repository's top folder. The skill says why, and says to
  keep the `cd` even when there is no `git add`.
- New test in `repo-root.test.mjs`: the filled-in command, run from `app/`,
  commits a modified and a new file under `app/`.
- Review LOW (the combined command was untested): `git add -A && git commit -m x`
  was added to the guard test. It is denied and gets the `! git commit` hint.
- The skill wording test now pins the full line, including the `cd`.

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 301 pass, 0 fail.

### Follow-up risk

- Review LOW, unusual file names, is open by decision. Names that
  `git status --porcelain` escapes (non-ASCII), or names containing `$`, a
  backtick, or `"`, break the double-quoted paths.
- Chained commands where a commit is not the first refused step lose the hint.
  Open by decision.

## Review remediation, third round

Status: IMPLEMENTED, with the human's agreement. It stays within S2 scope.

### Changes

- Review MEDIUM (quoted names): `git status --porcelain` wraps a name with a
  space in its own quotes (checked: ` M "old name.txt"`). The skill now says to
  use each file's real name, with git's quotes removed and its escapes undone.
- New test in `repo-root.test.mjs`. It reads paths from real `git status`
  output, the way the skill says to, and runs the printed command. The repo has a
  modified file, a new file with a space, and a rename between two names with
  spaces. `git status` is then clean. The test also asserts that git really
  quoted the name.
- The skill wording test pins the new instruction.

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 302 pass, 0 fail.

### Follow-up risk

- Open by decision:
  - non-ASCII names (git's octal escapes are not exercised by the test)
  - names containing `$`, a backtick, or `"`, which double quotes do not protect
  - chained commands where a commit is not the first refused step

## Review remediation, fourth round

Status: IMPLEMENTED, with the human's agreement. It stays within S2 scope.

### Changes

- Review MEDIUM (`$` and backticks in names): the printed line now puts every
  path and the message in single quotes. A `'` inside a name or message is
  written as `'\''`. The skill says why: route files like `routes/users.$id.tsx`
  are common.
- New test: `routes/users.$id.tsx` (modified), ``notes `x` $(date).md`` (new),
  and `it's.md` (new) are committed by the printed line. The test checks that
  `git status` is clean, and that the commit holds exactly those three names.
- Wording and helper tests updated to the single-quoted template.

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 303 pass, 0 fail.

### Follow-up risk

- Open by decision:
  - Non-ASCII names: git's octal escapes are not exercised by a test.
  - Chained commands where a commit is not the first refused step lose the hint.
  - `04-design.md` and `05-structure.md` still show the first version of the
    commit line. Updating them would reset their approvals. This log is the
    record of what shipped.
