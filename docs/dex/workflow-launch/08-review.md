**AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW.**

This report is supplemental evidence. It records no approval. A human must read the production diff and run `/dex:approve code workflow-launch`.

## Scope

- **What was reviewed:** the full diff for the workflow-launch feature. This is the change that copies the research and review workflow scripts into the project (`stage-workflow`), checks those copies in doctor, and has the skills launch the copies.
- **Base:** `50105344554f7ac19725541295d416a3f479d328`
- **Reviewed tree:** `0902563ec90042e018e818b9531a65ba8479f874`
- **Dimensions run:** correctness, design-conformance, test-adequacy.
- **Dimensions not run:** none. All requested dimensions ran.

## Verification Evidence

Overall status: **PASS** (ran at 2026-09-28T19:12:03.851Z).

| Command | Category | Exit code | Result |
|---|---|---|---|
| `node --test dex/tests/*.test.mjs` | unit | 0 | 296 pass, 0 fail, 0 skipped |
| `node dex/scripts/doctor.mjs` | static-analysis | 0 | Ready; both workflow staging checks PASS |

## Findings

### BLOCKER

None.

### HIGH

None.

### MEDIUM

#### M1. Nothing tests staging from a subfolder of the repository

- **Severity:** MEDIUM
- **File:** `dex/tests/state.test.mjs`, line 866
- **Symbol:** `sessionTop` / `stageWorkflow`
- **Claim:** No test runs stage-workflow or doctor from a subfolder. So nothing guarantees the copy lands at the top of the checkout rather than in the current folder.
- **Evidence:** Every stage-workflow test (`state.test.mjs` lines 811-876) and every doctor staging test uses the repository root or a worktree root as the working folder. `sessionTop` in `lib.mjs` is correct today because it asks git for the top folder. Doctor's staging check compares the copy against that same `sessionTop` value, so it cannot notice if that value is wrong.
- **Failure scenario:** A later edit makes `sessionTop` return the current folder. A session opened in `src/` then stages to `src/.dex/_workflows/`. The exclude line `/.dex/` only matches at the top, so `git status` shows a stray folder. All tests and doctor still pass.
- **Impact:** Starting a session in a subfolder is common, and nothing automated protects it. `LIVE-CHECKS.md` lists it only as an open manual check.
- **Recommended correction:** Add a `state.test.mjs` case that runs `stage-workflow research` from `<repo>/src`. Assert the printed path is `<repo>/.dex/_workflows/research.js`, that `<repo>/src/.dex` does not exist, and that `git status --porcelain` is empty.
- **Confidence:** high
- **Dimension:** test-adequacy

### LOW

#### L1. The skill test does not protect the no-fallback rule or the step order

- **Severity:** LOW
- **File:** `dex/tests/workflows-run.test.mjs`, line 52
- **Symbol:** finding 22 test
- **Claim:** The test does not check the rule against falling back to subagents or pasting the script inline. It also does not check that staging comes before the launch.
- **Evidence:** The test checks for the stage-workflow command, the placeholder `scriptPath`, the absence of the plugin-path `scriptPath`, and the "refuses to start the script ... /dex:doctor" sentence. Nothing matches "Do not fall back to subagents and do not paste the script inline". Nothing compares the positions of the steps.
- **Failure scenario:** Someone deletes the no-fallback sentence from a `SKILL.md`. The suite stays green. When the Workflow tool refuses a script, Claude pastes it inline. That is the old workaround the design rules out.
- **Impact:** The guard against the old workaround exists only as prose that no test protects.
- **Recommended correction:** Assert that both skills contain the no-fallback and no-inline wording. Assert that the stage-workflow command appears before the `scriptPath` line.
- **Confidence:** high
- **Dimension:** test-adequacy

#### L2. No test checks that the Dex guard allows stage-workflow

- **Severity:** LOW
- **File:** `dex/tests/shell-guard.test.mjs`, line 183
- **Symbol:** guard vs stage-workflow
- **Claim:** No guard test checks that the Dex guard allows `node state.mjs stage-workflow <name>` in the phases where the skills run it.
- **Evidence:** `shell-guard.test.mjs` has no stage-workflow case. Its list of harmless commands includes only `state.mjs set-slices`. The structure document names a guard refusal of stage-workflow as a risk that would stop the work.
- **Failure scenario:** A later guard change treats node scripts that write under `.dex/` as state writes. The guard refuses stage-workflow. `/dex:research` and `/dex:review` both stop at their first step. The suite stays green until a live run hits it.
- **Impact:** Both workflow launches would break, and a cheap test would catch it.
- **Recommended correction:** Add guard cases for `node "$STATE_CLI" stage-workflow research` after the questions are approved, and for `... stage-workflow review` in the worktree phase from the worktree. Assert both are allowed.
- **Confidence:** medium
- **Dimension:** test-adequacy

#### L3. The `--json` output of stage-workflow is never tested

- **Severity:** LOW
- **File:** `dex/tests/state.test.mjs`, line 819
- **Symbol:** `COMMANDS['stage-workflow']`
- **Claim:** The `--json` output of stage-workflow is never tested.
- **Evidence:** The tests read `r.text` and `r.json` without passing `--json`. The command builds the json object either way. So the `flags.json ? JSON.stringify(json) : staged` branch in `state.mjs` never runs in a test.
- **Failure scenario:** The flag branch breaks, for example it always prints the plain path. The output the README documents is wrong and no test fails.
- **Impact:** Small. The skills use the plain-text form, but the documented output is unprotected.
- **Recommended correction:** Add one test that runs `stage-workflow review --json` and parses `r.text` as JSON with the expected name and path.
- **Confidence:** high
- **Dimension:** test-adequacy

#### L4. The fallback for projects outside git is untested

- **Severity:** LOW
- **File:** `dex/tests/state.test.mjs`, line 838
- **Symbol:** `sessionTop` fallback
- **Claim:** The fallback for projects outside git (`top || root` in `sessionTop`) has no stage-workflow test.
- **Evidence:** All new stage-workflow tests call `makeRepo()` with git. The only `makeRepo({ git: false })` use in the file (line 717) is unrelated to staging.
- **Failure scenario:** `allowFail` is removed, or `top || root` becomes `top`. stage-workflow then fails or writes to the wrong place in every project not under git. The suite stays green.
- **Impact:** Only projects outside git are affected, and Dex already warns there. Still, a whole branch runs untested.
- **Recommended correction:** Add a stage-workflow test with `makeRepo({ git: false })` asserting the path is `<root>/.dex/_workflows/research.js`.
- **Confidence:** medium
- **Dimension:** test-adequacy

#### L5. The copy-failure message is only partly checked

- **Severity:** LOW
- **File:** `dex/tests/hygiene.test.mjs`, line 229
- **Symbol:** `stageWorkflow` copy-failure error
- **Claim:** The copy-failure message is checked only for the words "could not copy". Its destination path and the writable-folder hint are not checked. No test covers the failure through the command line.
- **Evidence:** The test "doctor fails when the workflows cannot be staged" asserts only `/could not copy/`. Doctor keeps just the first line of the message, so the hint on the later line is never checked. No `stateFails` test runs stage-workflow against a state folder that cannot be written.
- **Failure scenario:** The error loses its destination path or its "Check that .dex/ is a writable folder" hint. The skill passes this message to the user, who is not told where the copy failed. No test fails.
- **Impact:** Minor. It affects the quality of a failure message users see.
- **Recommended correction:** Add a `stateFails` test for stage-workflow where `.dex` is a file. Assert the message includes the `.dex/_workflows/<name>.js` path and the writable hint.
- **Confidence:** medium
- **Dimension:** test-adequacy

## Design Conformance

The change conforms to the design. No divergences were found.

## Test Assessment

The tests cover the main path well. They check that both workflows are copied byte for byte and that a hand-edited copy is overwritten. They cover a custom stateRoot, unknown names being rejected without creating the folder, and the `_workflows` folder not showing up as a feature. They also cover a clean `git status` in a repo where Dex was never set up, and linked worktrees (the copy goes in the worktree, state is read from the main checkout).

The doctor tests check that doctor writes only the staged copies. They check that it passes in a normal repo and in a worktree. They check that it fails on a symlinked state folder pointing outside the checkout, and on a copy that cannot be made. The skill tests check that both skills stage first and never launch the plugin path.

The gaps are listed in the findings above. The biggest is that nothing runs from a subfolder, which is the one common layout doctor cannot catch. Also untested are the `--json` output, the fallback outside git, the full failure message, the guard allowing stage-workflow, and the skills' no-fallback wording.

None of these is a defect in the current code. They are regressions the suite would miss. All six findings were kept after checking them against the code. None was a duplicate, and none is a blocker.

## Unverified Concerns

- Reviewers said manual probes confirmed that staging works today from a subfolder, outside git, and with `--json`, and that the guard currently allows stage-workflow. The code paths behind those claims were checked, but the probes were not rerun.

## AI Review Conclusion

**PASS.** No blockers and no high-severity findings. There is one medium and five low findings, all about missing tests rather than wrong code. This conclusion is not an approval. A human must read the production diff and run `/dex:approve code workflow-launch`.
