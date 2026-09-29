# Design: Checkpoints after drift

> Answers one question: WHERE ARE WE GOING?
> Requires explicit human approval. Optimize for decision leverage, not length.

## Problem

Once any checkpoint has started, `set-slices` refuses every change to the list of
checkpoint ids. Its error sends the user to `drift`. But after the drift is
resolved, the checkpoints are still started, so the same call is refused again.
A checkpoint that the structure gains mid-implementation can never be recorded.
In `workflow-launch`, step S5 was done outside Dex's state for this reason.

## Current State

- `set-slices` rebuilds the whole list from its arguments. It keeps each existing
  checkpoint's status, times, verification, and note by id. It refuses when any
  recorded checkpoint is not `pending` and the set of ids differs.
  (`dex/scripts/state.mjs:893-966`, check at `936-945`)
- "Started" there means any status other than `pending`, which includes a
  checkpoint that was blocked before it ever started. (`state.mjs:938`)
- Dropping a checkpoint needs `--replace`. Renaming and reordering are allowed
  even after work has started. (`state.mjs:946-952`)
- `drift` blocks the feature and touches no approval. Re-approving the drift's
  target clears the block by itself. (`state.mjs:1344-1413`)
- The checkpoint list and the structure are linked only by a warning. It lists
  ids named in `05-structure.md` but not recorded, and the reverse.
  (`state.mjs:972-992`)
- Every approval records `approvedAt` as an ISO time. `tryUnblock` already
  compares approval time against the drift time as strings. (`state.mjs:1391-1394`)
- `start-slice` sets `startedAt` to now each time it runs. (`state.mjs:1050-1051`)
- The implement skill offers no route for review or verification findings that
  fall outside the structure. (`dex/skills/implement/SKILL.md:72-132`)

## Desired End State

After you re-approve a revised structure, `set-slices` records the new list. New
checkpoints are added as `pending`. They can be started, verified, and finished
like any other, and status shows them. Checkpoints that have started keep their
history and can never be dropped. Without a fresh structure approval, Dex still
refuses. The refusal names steps that actually work.

## Relevant Existing Patterns

### Pattern 1: Freeze by status, route the change through a human approval

Evidence:
- `dex/scripts/state.mjs:936-945` (checkpoint freeze)
- `dex/scripts/state.mjs:1381-1413` (drift clears on re-approval)

Applicability to this change: kept. The freeze stays. A human approval is still
what lets the list change. What changes is which approval opens it.

### Pattern 2: Order approvals and events by comparing ISO timestamps

Evidence:
- `dex/scripts/state.mjs:1391-1394`

Applicability to this change: used directly. "Approved after the latest start" is
the same kind of comparison.

### Pattern 3: Carry fields over by id when the list is rewritten

Evidence:
- `dex/scripts/state.mjs:913-932`

Applicability to this change: kept unchanged. Started checkpoints keep their
records because the rewrite already carries them over.

## Proposed Design

1. **Unlock rule.** Once any checkpoint has started, `set-slices` may change the
   list only if the structure approval is current and newer than the latest
   `startedAt` among the recorded checkpoints. Otherwise it refuses as today.
   No new state field is needed. A second change after more work has started
   needs another structure approval.
2. **What "started" means.** A checkpoint counts as started when it has a
   `startedAt`. A checkpoint blocked before it ever started no longer freezes
   the list.
3. **What may change once unlocked.**
   - New ids can be added anywhere in the order. They start `pending`.
   - Pending checkpoints can be dropped, still only with `--replace`.
   - Renaming and reordering behave as today.
   - A started checkpoint can never be dropped, even with `--replace`, and even
     after a fresh approval.
4. **After the PR is recorded,** `set-slices` refuses. The feature is complete.
5. **The refusal message** names the steps that work: revise `05-structure.md`,
   `/dex:approve structure <slug>`, then run `set-slices` again. It mentions
   `drift` only for the case where the repository contradicted the design.
6. **Skills and README.**
   - The implement skill gains a short section for work found by review or
     verification that is not in the structure. It says to revise the
     structure, have the human re-approve it, record the new list, and continue.
   - The plan skill says that `set-slices` is re-run after a revised structure
     is approved.
   - The README line on `--replace` states the new rule.

## End-to-End Flow

```text
review finds a defect needing new work (S1–S4 complete)
  -> agent adds S5 to 05-structure.md       structure approval goes STALE
  -> human: /dex:approve structure <slug>   approvedAt > latest startedAt
  -> agent: set-slices <slug> S1..S4 S5     accepted; S5 pending, S1–S4 unchanged
  -> implementation gate INCOMPLETE         PR blocked until S5 is done
  -> start-slice S5 ... finish-slice S5     normal path
```

Without the re-approval, step 3 is refused, and the message names the steps above.

## Interfaces / Contracts

- The `set-slices` command line does not change.
- The error text changes (see Proposed Design, item 5).

## Data Changes

None. There is no new field and no schema version bump. The rule reads
`state.approvals.structure.approvedAt` and each checkpoint's `startedAt`, which
already exist.

## Security / Authorization

The model still cannot approve. The unlock depends on a structure approval,
which only the human's typed `/dex:approve` can record. That keeps the rule
"the list changes only after a human signs off on the new structure".

## Failure Semantics

Each refusal is a `DexError` with a message and a recovery step, as today:
- no fresh approval
- a started checkpoint would be dropped
- the PR is already recorded

## Compatibility

- Existing `state.json` files load unchanged.
- Finished features report the same status.
- For features in progress, the list can now be changed in cases that were
  refused before. That happens only after a fresh approval, or when the only
  non-pending checkpoints were blocked before they started.

## Observability

`set-slices` already appends a `plan_generated` event with the ids. No change.

## Resolved Decisions

| Decision | Resolution | Reason |
| -------- | ---------- | ------ |
| What unlocks the list | A structure approval newer than the latest checkpoint start | Human chose it. Review fixes like S5 are not drift, but both end in a re-approval. Needs no new state. |
| What may change | Add, reorder, rename. Drop pending only with `--replace`. Never drop started ones. | Human chose it. Keeps recorded history. Lets a fix land before a pending step. |
| Blocked-before-start freezes the list | No. "Started" means it has a `startedAt`. | A checkpoint that never ran has no history to protect. |
| `drift --slice` erases a checkpoint's completion | Out of scope | Human chose it. Separate bug, added to the queue. |
| Require `drift` before the change | No | A re-approval is the human decision that matters. Drift remains the tool for contradictions. |

## Open Questions

- None blocking. See Least-Confident Decisions.

## Alternatives Considered

### Alternative A: Require a recorded drift, cleared by re-approval

Advantages: Stricter. Every mid-flight change leaves a drift record.

Risks: Review fixes are not drift. It needs a new record of when the drift
cleared, because the block is set to `null` on clearing.

Reason rejected: The human chose the approval-time rule.

### Alternative B: Derive the list from `05-structure.md`

Advantages: One source of truth. No mismatch between the list and the structure.

Risks: The list would depend on parsing prose. It would change a working
convention, and the structure warnings already catch mismatches.

Reason rejected: Much larger change than the bug needs.

### Alternative C: Append only

Advantages: Simpler to reason about.

Risks: A fix that must land before a pending step cannot be placed there.

Reason rejected: The human chose add-anywhere.

## Non-Goals

- Recording S5 in the finished `workflow-launch` feature.
- `drift --slice` erasing a finished checkpoint's completion.
- `start-slice` restarting a finished checkpoint without a check.
- The two orderings: list position and id number.
- Deriving the checkpoint list from `05-structure.md`.
- Research reporting empty probes as answered.
- AI review being reset by text-only edits.

## Least-Confident Decisions

1. **Refusing `set-slices` after the PR is recorded.** Nobody asked for it, and
   research did not check how other commands treat a completed feature. It
   could be dropped as scope creep. The case for keeping it is that adding
   work to a completed feature produces a phase that says "complete" while the
   checkpoint list says "not done".
2. **The latest `startedAt` as the cut-off.** A restart of an old checkpoint
   moves it forward. That demands a new approval even if the structure did not
   change. The rule errs strict, which seems right, but it may surprise.
3. **Letting a checkpoint blocked before it started stop freezing the list.**
   It fixes a contradiction research found. But it is a behavior change beyond
   the bug, and a pending checkpoint with `blockedBy: drift` could then be
   dropped with `--replace`.
