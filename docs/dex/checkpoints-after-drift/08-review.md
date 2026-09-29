**AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW.**

This report is supplemental evidence. It records no approval. A human must read the production diff and run `/dex:approve code checkpoints-after-drift`.

# AI Review: checkpoints-after-drift

## Scope

The review covered the change that lets the checkpoint list be edited after the structure drifts. Under the new rule, the list unlocks only after a fresh structure approval. Started checkpoints can never be dropped.

- Base: `64e3e42092984ed07420513f03b4827a2877c353`
- Reviewed tree: `bb974f9c97d2b13548a6cb6e5404d235c27b3a5b`
- Dimensions run: correctness, design-conformance, test-adequacy, backward-compatibility.
- Dimensions not run: none. All requested dimensions ran.

## Verification Evidence

Overall status: PASS. Ran at 2026-09-29T01:45:11.674Z.

| Command | Category | Exit code | Result |
|---|---|---|---|
| `node --test dex/tests/*.test.mjs` | unit+integration | 0 | 314 pass, 0 fail |
| `node dex/scripts/doctor.mjs` | static analysis | 0 | Ready |

## Findings

### BLOCKER

None.

### HIGH

None.

### MEDIUM

None.

### LOW

#### 1. A recorded PR is reported only after a pointless structure re-approval

- **Severity:** LOW
- **File:** `dex/scripts/state.mjs`, line 913
- **Symbol:** `COMMANDS['set-slices']`
- **Confidence:** high
- **Dimension:** correctness
- **Claim:** When a feature's PR is recorded, `set-slices` checks the structure approval before it checks for the recorded PR. If the structure file was edited after the PR, the user is told to re-approve the structure first. Only after that are they told the feature is complete.
- **Evidence:** In `bb974f9c`, the check `!gates.structure.approved && config.strictGates` (lines 907-912) throws "Run: /dex:approve structure <slug>". That happens before the `if (state.pr?.created)` refusal at line 913.
- **Failure scenario:** The PR is recorded. Someone edits `05-structure.md`, so the approval goes stale. `set-slices` refuses and asks for `/dex:approve structure`. The human approves. `set-slices` is then refused again with "its PR is recorded... start a new feature". That approval was wasted.
- **Impact:** The human does one pointless approval before hearing the real reason. No state is corrupted. The command still refuses in the end.
- **Recommended correction:** Move the `state.pr?.created` check above the structure-approval check.

#### 2. No test drops a checkpoint that was blocked before it started

- **Severity:** LOW
- **File:** `dex/tests/gates.test.mjs`, line 348
- **Symbol:** `COMMANDS['set-slices']`, the `started` list
- **Confidence:** high
- **Dimension:** test-adequacy
- **Claim:** The new rule counts a checkpoint as started only if it has a start time. So a checkpoint that was blocked before it started can be dropped. No test checks this.
- **Evidence:** In `state.mjs` line 946, `started` is filtered on `startedAt`. That list is used only by the drop refusal and its error text. The lock itself comes from `latestStart`. The test at `gates.test.mjs:348` blocks S2 but then keeps S2 in the list, so it never reaches the drop path. The reviewer changed the filter back to `s.status !== 'pending'`, and all 314 tests still passed.
- **Failure scenario:** Block S2 before it starts. Start S1. Re-approve the structure. Run `set-slices feat S1:a S3:c --replace`. This works today. If someone brings back the status-based check, the command is refused with "Dex will not drop S2: already started", and the tests stay green.
- **Impact:** A behaviour the change claims to add could break without any test failing. It would only affect users who drop a checkpoint that was blocked but never started.
- **Recommended correction:** Add a test. Block S2 without starting it, start S1, re-approve the structure, then run `set-slices` with `--replace` and without S2. Assert the ids are `[S1, S3]`.

## Design Conformance

The change conforms to the approved design. No divergences were found.

## Test Assessment

The 11 new tests cover the main behaviour:

- The list unlocks only after a structure approval that is newer than the latest checkpoint start.
- A new start after that approval locks it again.
- A stale approval does not unlock it.
- Started checkpoints can never be dropped, even with `--replace`. This includes ones that were started and then blocked.
- Pending checkpoints can still be dropped with `--replace`.
- A checkpoint can be added before a pending one.
- A review fix can be added after every checkpoint has finished.
- The refusal message lists the steps to follow.
- `set-slices` is refused once the PR is recorded.

One gap: no test drops a checkpoint that was blocked before it started. Changing the "started" check back to a status check would still pass the whole suite (finding 2).

No test covers the order of checks for a recorded PR with a stale structure. That order is a usability problem, not a correctness one (finding 1).

## Unverified Concerns

None. Every concern raised was checked against the repository. None were dropped.

## AI Review Conclusion

**PASS.** There are no blockers and no high-severity findings. Two low-severity findings are worth fixing: reorder the recorded-PR check, and add the missing drop test. Neither one blocks the change. A human must still review the diff and run `/dex:approve code checkpoints-after-drift`.
