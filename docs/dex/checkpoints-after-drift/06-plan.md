# Tactical Plan: Checkpoints after drift

> This artifact exists for the implementation agent, not for the human reviewer.
> Reference exact files and symbols. Do not write method bodies here.

## Approved Inputs

- Design: `04-design.md`
- Structure: `05-structure.md`

## Ground Rules

1. Read the current code before editing it. The plan can be stale; code is truth.
2. If the repository contradicts the approved design, stop and record design drift.
3. Do not touch anything outside the checkpoint's stated files without surfacing it.

Test command for every checkpoint (Node's built-in runner, as used in earlier
Dex features):

```bash
node --test dex/tests/*.test.mjs
```

## Checkpoint S1: unlock rule in set-slices

### Objective

`set-slices` accepts a changed id set once work has started only when the
structure approval is current and newer than the latest `startedAt`. A started
checkpoint is never dropped. The refusal names the working steps.

### Preconditions

Structure approved, worktree ready, S1 started.

### Files

#### `dex/scripts/state.mjs`

Change: in `COMMANDS['set-slices']` (around line 893), replace the freeze check
at about lines 936-945.
- `started` becomes the checkpoints with a `startedAt`, not those with status
  other than `pending`.
- Compute the latest `startedAt`. Unlocked means there is no start, or
  `state.approvals.structure.approvedAt` is later than the latest start. The
  structure is already known to be approved at that point by the check at the
  top of the command. Keep the strict `>` string comparison, the same one
  `tryUnblock` uses.
- When the ids differ and the list is not unlocked, throw a `DexError`. The
  message names what is recorded and what was requested. It names the three
  steps: revise `05-structure.md`, `/dex:approve structure <slug>`, then run
  `set-slices` again. It says to record `drift` first only if the code
  contradicted the design.
- Add a new check before the `--replace` check. If any dropped id is a started
  checkpoint, throw a `DexError` naming it, even when `--replace` is given.
- The `--replace` check for pending drops stays as is.

Why: design items 1–3 and 5.

Relevant symbols: `COMMANDS['set-slices']`, `computeGates` (`gates.structure`),
`state.approvals.structure.approvedAt`, `tryUnblock` (the comparison precedent,
`state.mjs:1391-1394`), `DexError`.

#### `dex/tests/gates.test.mjs`

Change: add tests next to "finding 21: set-slices cannot change the checkpoints
once one has started" (line 264). Keep that test as it is.

Why: the structure's testing strategy.

Relevant symbols: `readyToImplement`, `runPromptHook('/dex:approve structure feat', root)`,
`write(root, \`${D}/05-structure.md\`, ...)`, `readState`, `stateFails`.

### Implementation Steps

1. Write the new tests first and watch them fail. See the Tests section.
2. Change the freeze check and add the started-drop refusal in `set-slices`.
3. Run the suite.

### Tests

To re-approve, edit `05-structure.md` so its hash changes, then call
`runPromptHook('/dex:approve structure feat', root)`. That is the pattern the
"finding 20: re-approving the revised documents unblocks" test uses (line 191).
Only fall back to `state(root, ['approve', 'structure', 'feat'])` if it is
confirmed to work for a re-approval.

1. Start S1, re-approve the structure, then run
   `set-slices S1 S2 S3:fix`. It succeeds. S3 is `pending`. S1 has
   `in-progress` and the same `startedAt` as before.
2. Start S1, re-approve, then run `set-slices S1 S3 S2`. The ids come back in
   the order S1, S3, S2.
3. Start S1, re-approve, then run `set-slices S2 --replace`. It is refused, and
   the message matches `/S1/` and says it started.
4. Start S1, re-approve, then run `set-slices S1 --replace`. It succeeds, and
   the ids are `['S1']`.
5. Start S1, re-approve, start S2, then run `set-slices S1 S2 S3`. It is
   refused.
6. Run `block-slice S2` on a pending S2 with no start, then
   `set-slices S1 S2 S3`. It succeeds with no re-approval.
7. Start S1, then run `set-slices S1 S2 S3` with no re-approval. The message
   matches `/dex:approve structure/`.

### Verification Commands

```bash
node --test dex/tests/gates.test.mjs
node --test dex/tests/*.test.mjs
```

### Expected Observable Result

All seven new tests pass. The existing "finding 21" tests still pass. The full
suite is green.

### Stop Conditions

Stop and return to design or structure if:

- a test's approval and start land on the same millisecond, so the strict
  comparison flakes
- re-approving the structure does something beyond what research described,
  such as resetting checkpoints
- anything other than `start-slice` turns out to write `startedAt`

## Checkpoint S2: completed features and the full path

### Objective

The review-remediation path works end to end. `set-slices` refuses once the PR
is recorded.

### Preconditions

S1 complete.

### Files

#### `dex/scripts/state.mjs`

Change: in `COMMANDS['set-slices']`, right after the structure-approved check,
refuse with a `DexError` when `state.pr?.created`. The message says the feature
is complete and a new feature is needed for further work.

Why: design item 4.

Relevant symbols: `state.pr`, `COMMANDS['record-pr']` (line 1322).

#### `dex/tests/gates.test.mjs`

Change: add the two integration tests. `readyToPublish` and
`completeImplementation` live here already, so the tests go here, not in
`e2e.test.mjs`.

### Implementation Steps

1. Write both tests. The PR test fails. The full-path test may already pass
   after S1. That is fine; it guards the path.
2. Add the PR-recorded refusal.

### Tests

1. Full path:
   - Setup: `readyToImplement()`, then `completeImplementation(root, 'feat', worktree)`.
   - Record `drift --target structure --reason review`.
   - Edit `05-structure.md` to add S3, then re-approve the structure through
     the hook.
   - Assert that `check` shows `blocked` is null.
   - Run `set-slices S1 S2 S3:fix`.
   - Assert that `check` shows implementation not `COMPLETE`, `canPr.allowed`
     false, and `next.command` naming S3 or `/dex:implement`. Use the form
     `nextAction` actually produces.
   - Start and finish S3 with `--verification`.
   - Assert that implementation is `COMPLETE`.
2. PR recorded: `readyToPublish()`, then `record-pr feat`. After that,
   `set-slices S1 S2 S3` is refused with a message matching `/complete/`.

### Verification Commands

```bash
node --test dex/tests/gates.test.mjs
node --test dex/tests/*.test.mjs
```

### Expected Observable Result

Both tests pass. The suite is green.

### Stop Conditions

- The verification or AI-review gate stays PASS or crashes after a checkpoint
  is added to a completed implementation, in a way the design did not expect.
- The drift block does not clear after the structure re-approval in this flow.

## Checkpoint S3: guidance and release notes

### Objective

Anyone who hits this situation is told the working route.

### Preconditions

S2 complete.

### Files

#### `dex/skills/implement/SKILL.md`

Change: add a short section after section 6 on design drift, for work found by
review or verification that the approved structure does not contain. The route
is:
- add the checkpoint to `05-structure.md`
- ask the human to run `/dex:approve structure <slug>`
- re-run `set-slices` with the full list
- continue with `start-slice`

Say that started checkpoints stay in the list. Use plain words, matching the
file's style.

#### `dex/skills/plan/SKILL.md`

Change: in section 3, add one sentence. After a revised structure is approved,
run `set-slices` again with the full list. Started checkpoints keep their
records and cannot be dropped.

#### `dex/README.md`

Change: the `set-slices` row (line 453) states the rule. `--replace` drops
pending checkpoints. Once work has started, the list changes only after the
structure is re-approved, and started checkpoints are never dropped.

#### `dex/CHANGELOG.md`, `dex/.claude-plugin/plugin.json`

Change: add a `## [0.2.3] — <date>` entry under `### Fixed`, in the style of
0.2.2. Bump `version` to `0.2.3`.

### Implementation Steps

1. Edit the three docs.
2. Add the CHANGELOG entry and bump the version.
3. Run the suite.

### Tests

1. `docs.test.mjs` covers these: the README documents every command, skills
   name only documented commands, and the version matches the CHANGELOG.

### Verification Commands

```bash
node --test dex/tests/docs.test.mjs
node --test dex/tests/*.test.mjs
node dex/scripts/doctor.mjs
```

### Expected Observable Result

The suite is green, and doctor passes.

### Stop Conditions

- A docs test requires wording the design did not anticipate, in a way that
  changes meaning.
