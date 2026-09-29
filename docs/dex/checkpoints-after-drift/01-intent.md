# Feature Intent: Checkpoints after drift

> Written before any research. Describe the problem, not the solution.
> If a section does not apply, write "Not applicable" rather than inventing content.

## Problem

Once any checkpoint of a feature has started, Dex refuses every change to the
list of checkpoints. A checkpoint is one planned step of the implementation,
recorded with `set-slices`.

The refusal tells the user to record design drift instead. But after the drift
is recorded and the structure is re-approved with a new checkpoint, `set-slices`
still refuses. Nothing in Dex lets the new checkpoint be recorded. The advice in
the error leads back to the same error.

This happened in the `workflow-launch` feature. Review found a defect. The human
agreed to fix it as a new step, S5. Dex would not record S5, so the work was
done outside Dex's state. It appears only as a note in
`docs/dex/workflow-launch/07-implementation-log.md`. Dex's status, next-step
advice, and verification tracking never knew S5 existed.

The person blocked is the developer running a Dex feature whose plan grows
after implementation has begun. Review remediation is the common case.

## Desired Outcome

When the structure changes after implementation has begun, and that change has
gone through Dex's normal drift-and-re-approval path, the new checkpoint can be
recorded. It then behaves like any other checkpoint: it can be started, verified,
and completed, and it shows up in status.

Checkpoints that have already started or finished keep their recorded history.
Dex still refuses a checkpoint change that has not gone through that path.

## User / Actor

A developer driving a Dex feature through Claude Code, and the agent running
the implementation stage on their behalf.

## Scope

- Recording new checkpoints after earlier ones have started, when the structure
  change was made through drift and re-approval.
- Making the error message's advice actually lead somewhere that works.

## Non-Goals

- Retroactively recording S5 in the finished `workflow-launch` feature.
- The research workflow reporting empty probes as "answered".
- AI review being reset by text-only edits.
- Letting Dex silently accept checkpoint changes with no drift or approval.
- Changing how checkpoints are verified or completed.

## Constraints

- Existing `state.json` files for finished features must still load and report
  the same status.
- Approvals and gates must keep their current meaning. A structure change must
  still make the structure approval stale until it is re-approved.
- The rest of Dex's tests must keep passing.

## Acceptance Signals

- In a feature where S1 is complete, record structure drift, re-approve the
  structure, then record S1, S2, and a new S3. The command succeeds.
- `state.json` then holds S3 as pending, and S1 keeps its original status,
  start time, and verification.
- `/dex:status` lists S3, and `/dex:next` points to starting it when it is the
  next pending checkpoint.
- Running the same `set-slices` without drift and re-approval is still refused.
- The refusal message names a sequence of steps that, when followed, succeeds.

## Unknowns

- Should removing or renaming a started checkpoint also be allowed after drift,
  or only adding new ones? Unknown — needs a decision.
- Does "after drift" mean the structure approval must be fresh again, or is a
  recorded drift enough? Unknown — needs research into how drift and approvals
  interact today.
- Can a checkpoint be inserted in the middle of the order, or only appended?
  Unknown — needs a decision.
- Does the implementation gate or code approval already assume a fixed
  checkpoint list? Unknown — needs research.
- What happens to a feature whose implementation is already marked complete
  when a new checkpoint is added? Unknown — needs research.
