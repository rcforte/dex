# Program Structure: Commit before worktree

> Answers one question: HOW DO WE GET THERE IN SAFE, OBSERVABLE STEPS?
> Closer to header files than to code: types, signatures, file locations,
> call flow, execution order, verification points. No implementation bodies.
> Requires explicit human approval.

## Approved Design

Reference: `04-design.md`

## Change Surface

### Existing files modified

- `dex/scripts/guard.mjs` — in `decide()`, the `change.kind === 'command'` refusal
  (`guard.mjs:356-366`) gains one line when `change.what` is `git commit`. The
  decision is unchanged.
- `dex/tests/guard.test.mjs` — new tests for that line.
- `dex/skills/worktree/SKILL.md` — step 2, "Inspect the repository first", replaces
  the bare "stop and ask" with the two-choice flow. The existing
  `git status --porcelain -- . ':!<artifactRoot>'` command stays verbatim;
  `repo-root.test.mjs:92-94` reads it.
- `dex/tests/workflow.test.mjs` — a static test that pins the new skill wording.
- `dex/CHANGELOG.md`, `dex/.claude-plugin/plugin.json` — a patch version entry
  (0.2.2). A test requires the two to match.

### New files

- None.

### Deleted files

- None.

## Important Types

Not applicable.

## Important Interfaces

```text
guard refusal text, change.kind 'command', change.what === 'git commit'
  existing text, plus one line:
  "To commit work that is not part of this feature, run it yourself by typing
   ! git commit ... in the prompt. Dex does not check commands you run."
  (Exact wording settled in implementation. It must contain "! git commit".)

worktree skill, step 2 — two choices when git status is non-empty:
  continue  -> go on to step 3 unchanged
  commit    -> print  ! git commit -m "<message>" -- <quoted paths>  and stop
```

## End-to-End Call Flow

```text
/dex:worktree -> git status (dirty) -> ask: continue | commit
  continue -> steps 3-6 unchanged
  commit   -> printed "! git commit ..." -> user runs it -> /dex:worktree again

Claude tries git commit before implement
  -> guard decide() -> deny (unchanged) -> reason now includes the "! git commit" line
```

## Testing Strategy

### Existing tests extended

- `guard.test.mjs` "repository mutations during design are DENIED" is unchanged.
  It proves every decision is still deny.

### New unit tests

- `guard.test.mjs`: in the `worktree` phase and in the `design` phase,
  `git commit -am x` is denied, and the reason contains `! git commit`.
- `guard.test.mjs`: `rm -rf src` in the `design` phase is denied, and its reason
  does NOT contain `! git commit`. The line is commit-only.
- `workflow.test.mjs`: the worktree skill mentions both choices, contains
  `! git commit`, and still forbids stash, reset, and clean. It must not tell the
  model to run `git commit` itself.

### Integration tests

- `repo-root.test.mjs` still passes. The dirty-tree command is unchanged.

### End-to-end tests

- Manual, in this repository: with a modified tracked file on `master`, running
  `/dex:worktree` for a feature in the worktree phase shows the two choices. A
  Claude commit attempt shows the new line. This happens naturally when a later
  feature reaches the worktree step.

## Implementation Shape

Tracer bullet required: NO

Reason: two localized text changes. No integration or architecture uncertainty.

### Checkpoint S1 — The guard's commit refusal names the way out

Objective: a refused `git commit` tells the user how to commit it themselves.

Vertical path:

```text
Bash git commit -> guard decide() -> deny -> reason with "! git commit" line
```

Verification: the new guard tests, then `node --test dex/tests/*.test.mjs`.

### Checkpoint S2 — The worktree skill offers two choices

Objective: `/dex:worktree` with a dirty main checkout asks "continue or commit",
and gives a working commit line.

Vertical path:

```text
/dex:worktree -> step 2 text -> continue | printed ! git commit line
```

Verification: the new static skill test, `repo-root.test.mjs`, and the full suite.
The changelog and version bump belong here too.

## Backout / Reversibility

Both checkpoints are text-only. A plain revert restores the old behaviour.

## Risk Checkpoints

- If `change.what` is not exactly `git commit` for variants such as
  `git commit --amend` or `git -C x commit`, stop. Decide with the human whether
  the line keys on the label or on the git subcommand.

## Least-Confident Structural Decisions

1. **Keying the line on `change.what === 'git commit'`.** This depends on how
   `commands.mjs` labels commit variants. S1 checks it.
2. **Testing the skill by static text.** It pins wording, not behaviour. That is
   the only kind of test that exists for skills here.
3. **No live check planned.** The trap shows up again naturally the next time a
   feature reaches the worktree step with a dirty tree.
