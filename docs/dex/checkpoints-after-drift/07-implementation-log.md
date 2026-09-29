# Implementation Log: Checkpoints after drift

> Appended once per checkpoint. Concise: this is the compaction artifact a fresh
> context reads instead of replaying the whole session.

## S1: unlock rule in set-slices

Status: IMPLEMENTED

### Changes

- `set-slices` sees a checkpoint as started when it has a `startedAt`. Before,
  any status other than `pending` counted.
- The id set may change once work has started only when
  `approvals.structure.approvedAt` is later than the latest `startedAt`. It is
  the same string comparison `tryUnblock` uses.
- The refusal lists the three steps: revise `05-structure.md`, then
  `/dex:approve structure`, then run `set-slices` again. It mentions `drift`
  only for contradictions. It keeps the words "already started", which an
  existing test matches.
- A new refusal: a started checkpoint cannot be dropped, even with
  `--replace`.
- Seven tests in `gates.test.mjs`, with a `reapproveStructure` helper. It
  edits the structure and approves through the prompt hook, the same way the
  finding 20 test does.

### Files

- `dex/scripts/state.mjs`, `dex/tests/gates.test.mjs`

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 310 pass, 0 fail. The new tests were run 3 more times and stayed green,
with no timing flake on the strict comparison.

### Divergence from plan

None. Two new tests passed before the change, because the old lock refused
those cases for its own reason. They are the started-drop test and the
started-after-re-approval test. They stay as guards.

### New discoveries

None.

### Follow-up risk

- The rule trusts `startedAt` to be written only by `start-slice`. A search of
  `dex/scripts` confirmed that.

## S2: completed features and the full path

Status: IMPLEMENTED

### Changes

- `set-slices` refuses once `state.pr.created` is set. The message says the
  feature is complete and to start a new one. The check sits right after the
  structure-approved check.
- A full-path test. Both checkpoints finish, then a structure drift is recorded
  and the structure is re-approved, which clears the block by itself. Then S3
  is added. After that, implementation is not complete, PR is blocked, and
  `next` is `/dex:implement feat S3`. Starting and finishing S3 makes
  implementation COMPLETE.
- A test that `set-slices` is refused after `record-pr`, even with a fresh
  structure approval.

### Files

- `dex/scripts/state.mjs`, `dex/tests/gates.test.mjs`

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 312 pass, 0 fail.

### Divergence from plan

None. The full-path test passed before any S2 code, as the plan expected. S1
already made that path work. It stays as a guard.

### New discoveries

- The verification and AI review results are bound to the git tree of the code
  they checked (`resultStillApplies`, `state.mjs:203-209`). A new checkpoint
  that changes code therefore resets both results by itself. The stop
  condition about a gate that stays PASS for code it never saw does not apply.

### Follow-up risk

None.

## S3: guidance and release notes

Status: IMPLEMENTED

### Changes

- Implement skill: a new subsection "New work the structure does not have" at
  the end of section 6. It gives four steps: add the checkpoint to the
  structure, have the user approve it, re-run `set-slices` with the full list,
  and implement it as usual. It is placed as a subsection, not a new numbered
  section, so sections 7 and 8 keep their numbers.
- Plan skill: one paragraph. After a revised structure is approved
  mid-implementation, re-run `set-slices` with the full list.
- README: the `set-slices` row states the new rule.
- CHANGELOG: a 0.2.3 entry under Fixed. `plugin.json` is bumped to 0.2.3.

### Files

- `dex/skills/implement/SKILL.md`, `dex/skills/plan/SKILL.md`, `dex/README.md`,
  `dex/CHANGELOG.md`, `dex/.claude-plugin/plugin.json`

### Verification

Command: `node --test dex/tests/*.test.mjs` and `node dex/scripts/doctor.mjs`

Result: 312 pass, 0 fail. The docs tests pass, including the check that the
version matches the CHANGELOG. Doctor reports Ready.

### Divergence from plan

- The plan said "a short section after section 6". It was added as a
  subsection of section 6 to avoid renumbering.

### New discoveries

None.

### Follow-up risk

- The running plugin still loads skills from the main checkout. The new skill
  text takes effect only after merging to master and restarting Claude Code.

## Review remediation (round 1)

Status: IMPLEMENTED. These fixes stay within S1's approved rule and need no new
checkpoint. The user agreed to them after the first AI review.

### Changes

- M1: the unlock rule now reads the structure approval only when it is current:
  `gates.structure.approved ? gates.structure.approvedAt : null`. Before, a
  stale approval still unlocked the list when `strictGates` was false. This
  conforms to design item 1.
- M1 test: with `strictGates:false`, the structure is re-approved, then edited
  again, then `set-slices` adds S3. It is refused. The test failed with the fix
  stashed and passes with it.
- L2: the review-fix test asserts that S1's whole record is unchanged after
  `set-slices`.
- L3: a new test. A checkpoint started and then blocked still locks the list,
  and it cannot be dropped after re-approval.

### Verification

Command: `node --test dex/tests/*.test.mjs`, `node dex/scripts/doctor.mjs`

Result: 314 pass, 0 fail. Doctor passes.

### Deferred

- L1: `set-slices` rebuilds each kept checkpoint from a fixed field list and
  drops `blockedBy`. A checkpoint blocked by a drift then stays blocked after
  the drift clears. This behavior predates this feature, and research recorded
  it. It is logged as a follow-up.

## Review round 2: deferred findings

The second AI review passed with 0 BLOCKER, 0 HIGH, 0 MEDIUM, and 2 LOW. Both
LOW findings are deferred as follow-ups:

- **Order of checks.** After the PR is recorded, a stale structure approval is
  reported before "the feature is complete". The fix would move the
  `state.pr?.created` check above the structure-approved check in `set-slices`.
- **Missing test.** No test drops a checkpoint that was blocked before it
  started. Reverting "started" to a status check would still pass the whole
  suite. The fix would add a test: block S2, start S1, re-approve, then run
  `set-slices S1 S3 --replace`, and expect `[S1, S3]`.
