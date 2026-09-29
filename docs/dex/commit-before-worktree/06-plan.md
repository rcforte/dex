# Tactical Plan: Commit before worktree

> This artifact exists for the implementation agent, not for the human reviewer.
> Spot-check it for obvious divergence. Do not substitute reading it for
> reading the production code.
>
> Reference exact files and symbols. Do not write method bodies here.

## Approved Inputs

- Design: `04-design.md`
- Structure: `05-structure.md`

## Ground Rules

1. Read the current code before editing it. The plan can be stale; code is truth.
2. If the repository contradicts the approved design, stop and record design drift.
3. Do not touch anything outside the checkpoint's stated files without surfacing it.
4. Verification command throughout: `node --test dex/tests/*.test.mjs`.

## Facts checked while planning

- Every commit variant is labelled `git commit`. `gitChange()` returns
  `` `git ${sub}` `` for anything in `GIT_CHANGE` (`commands.mjs:79-91`).
  `gitParts()` strips global options such as `-C` first. So
  `git commit --amend` and `git -C x commit` both give `change.what === 'git commit'`.
  The structure's risk checkpoint does not trigger.
- In `guard.test.mjs`, the feature phase "worktree" (plan written, no worktree
  yet) is `ctxAt('plan')`. `ctxAt('worktree')` already has a worktree recorded,
  so implementation is unlocked there. (`helpers.mjs` `advanceTo` order.)

## Checkpoint S1: The guard's commit refusal names the way out

### Objective

When the guard refuses `git commit` before implementation, the reason contains a
line telling the user to run `! git commit …` themselves.

### Preconditions

Worktree recorded. The full suite passes on the starting commit.

### Files

#### `dex/scripts/guard.mjs`

Change: in `decide()`, in the `change.kind === 'command'` denial (around lines
356-366), append one paragraph before `footer` only when
`change.what === 'git commit'`. Suggested wording:
"To commit work that is not part of this feature, run the commit yourself by
typing `! git commit …` in the prompt. Dex does not check commands you run."
It must contain the literal `! git commit`.

Why: the current `Next:` line in the worktree phase is `/dex:worktree`, which
loops back.

Relevant symbols: `decide`, `repoChange`, `denial`, `footer`, `change.what`.

Do not touch the lockdown path (`lockedDecision`, around lines 383-394). That is
out of scope by design.

#### `dex/tests/guard.test.mjs`

Change: add tests next to "a denial explains the phase, the blockers, and the
recovery command".

### Implementation Steps

1. Add the conditional line in `decide()`.
2. Add the tests.
3. Run the full suite.

### Tests

1. `ctxAt('plan')`: `git commit -am x`, `git commit --amend`, and
   `git -C sub commit -m x` are each denied, and each reason matches
   `/! git commit/`.
2. `ctxAt('design')`: `git commit -am x` is denied, and its reason matches
   `/! git commit/`.
3. `ctxAt('design')`: `rm -rf src` and `git merge main` are denied, and their
   reasons do not match `/! git commit/`.

### Verification Commands

```bash
node --test dex/tests/*.test.mjs
```

### Expected Observable Result

The suite is green. The existing "repository mutations during design are DENIED"
test passes unchanged.

### Stop Conditions

- Any existing guard test changes from deny to allow, or the reverse. That means
  the decision changed, which the design forbids.
- `change.what` turns out not to be `git commit` for some commit variant. Return
  to structure.

## Checkpoint S2: The worktree skill offers two choices

### Objective

`/dex:worktree` step 2 turns the bare "stop and ask" into a two-choice question
with a working commit line.

### Preconditions

S1 complete.

### Files

#### `dex/skills/worktree/SKILL.md`

Change: in "## 2. Inspect the repository first — never discard user work", keep
the `git status --porcelain -- . ':!<artifactRoot>'` block verbatim.
`repo-root.test.mjs:92-94` reads it. Replace the "If there are uncommitted
changes, stop and ask" paragraph with:
- List the changed paths. Say they will not be in the new worktree, which starts
  from the last commit.
- Ask the user to choose:
  - **Continue without them:** go on to step 3. The changes stay in the main
    checkout, untouched.
  - **Commit them first:** print
    `! git commit -m "<message>" -- <each path, quoted>` for the user to run, then
    stop. Say that Dex refuses this commit from Claude before implementation,
    which is why the user runs it. After they run it, they re-run `/dex:worktree`.
- Keep the rule: never stash, reset, check out over, or clean, and never run the
  commit yourself.

#### `dex/tests/workflow.test.mjs`

Change: add a static test on `skills/worktree/SKILL.md`, using the same
`staticText` or `fs.readFileSync(path.join(PLUGIN_ROOT, ...))` style the file
already uses. Assert that:
- it contains `! git commit`
- it mentions continuing without the changes
- it still forbids stash, reset, and clean
- it contains an instruction not to run the commit itself

#### `dex/CHANGELOG.md`, `dex/.claude-plugin/plugin.json`

Change: add `## [0.2.2] — 2026-09-28` under Fixed. Say `/dex:worktree` now offers
"continue" or "commit it yourself", and that the guard's commit refusal names
`! git commit`. Set `version` to `0.2.2`.

### Implementation Steps

1. Edit the skill.
2. Add the static test.
3. Bump the changelog and version.
4. Run the full suite.

### Tests

1. The new static test.
2. `repo-root.test.mjs` passes unchanged.
3. `docs.test.mjs`, which checks the version and changelog match, passes.

### Verification Commands

```bash
node --test dex/tests/*.test.mjs
```

### Expected Observable Result

The suite is green.

### Stop Conditions

- `repo-root.test.mjs` or `docs.test.mjs` needs a change beyond the version
  bump. Surface it; do not loosen the test.
