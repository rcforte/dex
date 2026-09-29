# Program Structure: Checkpoints after drift

> Answers one question: HOW DO WE GET THERE IN SAFE, OBSERVABLE STEPS?
> Requires explicit human approval.

## Approved Design

Reference: `04-design.md`

## Change Surface

### Existing files modified

- `dex/scripts/state.mjs` — changes to `set-slices`:
  - the freeze check uses the new unlock rule
  - "started" means the checkpoint has a `startedAt`
  - dropping a started checkpoint is refused, even with `--replace`
  - the command refuses after the PR is recorded
  - the refusal message is rewritten
- `dex/tests/gates.test.mjs` — the existing test "cannot change the checkpoints
  once one has started" is kept, and new cases are added beside it.
- `dex/tests/e2e.test.mjs` or `dex/tests/state.test.mjs` — one full-path
  scenario, placed wherever the neighbouring full-path tests live.
- `dex/skills/implement/SKILL.md` — a new short section for work found outside
  the structure.
- `dex/skills/plan/SKILL.md` — one sentence: re-run `set-slices` after a revised
  structure is approved.
- `dex/README.md` — the `set-slices` row describes the new rule.
- `dex/CHANGELOG.md` and the plugin version — a v0.2.3 entry, following the
  v0.2.1 and v0.2.2 convention.

### New files

None.

### Deleted files

None.

## Important Types

No new types. The rule reads fields that already exist:

```text
state.approvals.structure.approvedAt   ISO string, set by approve
slice.startedAt                        ISO string | null, set by start-slice
state.pr.created                       boolean, set by record-pr
```

## Important Interfaces

```text
node state.mjs set-slices <slug> "S1:name" ... [--replace]      unchanged shape

helper inside state.mjs (name decided in code):
  latestStart(slices) -> ISO string | null
  list may change iff latestStart is null
                   or (structure approved and approvedAt > latestStart)
```

Refusal messages, in the order they are checked:

1. PR recorded: "the feature is complete".
2. The list changes, work has started, and there is no approval newer than the
   latest start. The message names the three steps: revise the structure,
   `/dex:approve structure <slug>`, then run `set-slices` again. It names
   `drift` only for the case where the code contradicted the design.
3. A started checkpoint would be dropped. This is refused even with
   `--replace`, and the message names the checkpoint.
4. A pending checkpoint would be dropped without `--replace`. This is the same
   as today.

## End-to-End Call Flow

```text
set-slices
  -> load state, compute gates          (unchanged)
  -> structure approved?                (unchanged refusal)
  -> PR recorded?                       new refusal
  -> parse specs, carry over by id      (unchanged)
  -> duplicates?                        (unchanged)
  -> ids changed and not unlocked?      rewritten check and message
  -> started checkpoint dropped?        new refusal
  -> pending dropped w/o --replace?     (unchanged)
  -> save, plan_generated event, structure warnings   (unchanged)
```

## Testing Strategy

### Existing tests extended

- `gates.test.mjs` "cannot change the checkpoints once one has started" stays
  green. It adds S3 with no re-approval, so it is still refused.
- The whole suite (`node --test dex/tests/*.test.mjs`) stays green, including
  the docs tests that check the README and skills name only documented commands.

### New unit tests (gates.test.mjs, through the real CLI)

- S1 started, the structure is edited and re-approved, then S3 is added: the
  call succeeds. S3 is `pending`. S1 keeps its `status` and `startedAt`.
- After re-approval, S3 is inserted between S1 and S2: the list order is
  S1, S3, S2.
- After re-approval, dropping S1 (started) with `--replace` is refused and
  names S1.
- After re-approval, dropping S2 (pending) with `--replace` succeeds.
- After re-approval, S2 is started, then another checkpoint is added: this is
  refused, because the approval is older than the latest start.
- A checkpoint blocked before it started (`block-slice` on a pending one) does
  not freeze the list.
- The refusal message names `/dex:approve structure`.

### Integration tests

- The full path: both checkpoints finish, then drift on the structure, then the
  structure is revised and re-approved. The block clears. Then `set-slices`
  adds S3. `next` then points to `start-slice` for S3, `check` shows
  implementation incomplete, and PR is blocked. Starting and finishing S3 makes
  implementation complete again.
- After `record-pr`, `set-slices` is refused.

### End-to-end tests

Not applicable beyond the integration scenario above. It already drives the
real CLI.

## Implementation Shape

Tracer bullet required: NO

Reason: The change is local to one command in one file, and the path through it
is well understood. There is no new integration boundary to prove.

### Checkpoint S1: unlock rule in set-slices

Objective: After a fresh structure approval, new checkpoints can be recorded.
Started checkpoints are never dropped. Without the approval, the refusal names
steps that work.

Vertical path:

```text
CLI argv -> set-slices -> gate/approval read -> rule -> state.json -> CLI output
```

Implementation depth: production. This covers the rule, the definition of
"started", the started-drop refusal, and the rewritten message.

Verification: the new `gates.test.mjs` cases above, plus the full suite.

Expected approximate change surface: about 30 lines in `state.mjs`, about 80
lines of tests.

### Checkpoint S2: completed features and the full path

Objective: The whole remediation path works end to end. A completed feature
refuses checkpoint changes.

Vertical path:

```text
drift -> approve structure (auto-unblock) -> set-slices -> next/check -> start/finish S3
```

Implementation depth: the PR-recorded refusal in `set-slices`, plus the
integration scenario.

Verification: the two integration tests above. `node dex/scripts/state.mjs next`
in the scenario prints `start-slice` for S3.

### Checkpoint S3: guidance and release notes

Objective: A user or agent who hits the situation is told the working route.

Vertical path:

```text
implement skill / plan skill / README -> docs tests -> CHANGELOG + version
```

Verification: `docs.test.mjs` passes. This covers the README command table,
skills naming only documented commands, and the version matching the
CHANGELOG. A reviewer reading the implement skill finds the route for review
findings that fall outside the structure.

## Backout / Reversibility

Each checkpoint is one or two commits on the feature branch, with no state
format change. Reverting a commit restores the old behavior. Existing
`state.json` files are unaffected either way.

## Risk Checkpoints

- If the approval time and a start time can be equal to the millisecond in
  practice, stop. For example, if a test flakes on the strict comparison, return
  to design rather than loosening the comparison silently.
- If anything besides `start-slice` sets `startedAt`, stop and return to
  design. The rule assumes that is the only writer.
- If making a feature's implementation incomplete again breaks the verification
  or AI review gates in a way the design did not expect, stop and return to
  design. Examples are a gate that crashes, or one that stays PASS for code it
  never saw.

## Least-Confident Structural Decisions

1. **Where the full-path scenario lives.** `e2e.test.mjs` fits its scope, but
   it may carry heavier git setup than this needs. The final location is
   decided in code, next to the most similar existing test.
2. **Splitting the PR refusal into S2 rather than S1.** It is small enough to
   ride in S1. It sits in S2 because S2 is where a completed feature is first
   exercised.
