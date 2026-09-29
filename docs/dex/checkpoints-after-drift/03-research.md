# Codebase Research: checkpoints-after-drift

> Objective findings about the system as it exists today.
> Produced by isolated workers that never saw the feature request.

In this report, "checkpoint" and "slice" mean the same thing. The code calls them
slices (`state.slices`). The user-facing text calls them checkpoints.

## Scope

Questions investigated:

1. What `set-slices` does, when it refuses, and what it keeps from a prior slice.
2. What `drift` changes in `state.json`, and what clears the blocked state.
3. How slices are stored, every slice field, and whether list order means anything.
4. Which code reads the slice list for gates, status or the next command, and what it assumes.
5. How the structure approval relates to the slice list.
6. How an existing `state.json` is loaded, and whether slices are versioned or migrated.
7. Which error messages, skills or README text advise on changing the list after work has started.
8. Which tests cover `set-slices`, `drift` and the blocked state.
9. What happens to later stages when earlier work changes after implementation.
10. What the implement skill says to do when review or verification finds work outside the structure.

Questions that could not be answered, and why:

- None went unanswered. Gaps within answers are listed as UNKNOWN below.

## Executive Map

- `dex/scripts/state.mjs` owns all slice logic. It holds the commands `set-slices`,
  `start-slice`, `finish-slice`, `block-slice`, `drift`, `unblock` and `approve`. It also
  holds gate computation (`computeGates`, `sliceSummary`), the phase label
  (`derivePhase`) and the next-command suggestion (`nextAction`).
- `dex/scripts/lib.mjs` creates new feature state (`slices: []`), loads it
  (`loadFeatureState`) and holds the default config (`strictGates: true`).
- `dex/scripts/status.mjs` reads only the computed implementation status, never the list.
- `dex/skills/implement/SKILL.md` and `dex/skills/plan/SKILL.md` tell the agent when to run
  `drift` and `set-slices`.
- The slice list lives in `state.json` apart from `05-structure.md`. It is typed in by
  hand and is never hashed with the structure.

## Current System Flow

```text
/dex:plan  -> state.mjs set-slices <slug> S1:name S2:name ...
             -> refuse if: no specs | structure not approved (strictGates) | bad id
                           | duplicate id | any slice non-pending AND id set changed
                           | would drop an id without --replace
             -> state.slices = new list (status/timestamps/verification/note kept by id)
             -> save, event plan_generated, warnings vs 05-structure.md text
/dex:implement -> start-slice (status in-progress) -> finish-slice (status complete)
             -> on contradiction: state.mjs drift <slug> --target design|structure
                                   --reason ... [--slice Sn]
                -> state.blocked = {kind design-drift, target, slice, since, reason}
                -> named slice: status blocked, blockedBy drift
                -> canImplement false; finish-slice refused; guard denies code edits
human revises design/structure -> /dex:approve
             -> tryUnblock: all three approvals current AND target approvedAt > since
                -> state.blocked = null; drift-blocked slices -> in-progress or pending
             -> the slice list itself is unchanged; set-slices still refuses id changes
                because started slices are still non-pending
```

## Findings

### Q1: What `set-slices` does, when it refuses, and what it keeps

Verification: VERIFIED

#### Facts

- FACT: Order of work: parse flags; take the slug and the checkpoint specs; take the
  feature lock; load state; compute gates; parse each `<id>:<name>` spec; check
  duplicates, then started-checkpoint changes, then drops; set `state.slices`; refresh
  phase; save; append a `plan_generated` event; compute warnings; return.
  Evidence:
  - `dex/scripts/state.mjs:893-966`
- FACT: Refusals, in the order they run:
  1. Unknown or non-boolean `--flag` with no value. Only `json`, `replace` and `review`
     are boolean. Evidence: `dex/scripts/state.mjs:563-586`
  2. Missing slug (`requireSlug`). Evidence: `dex/scripts/state.mjs:588-590`
  3. No specs after the slug. Evidence: `dex/scripts/state.mjs:897-902`
  4. Structure not approved while `config.strictGates` is truthy. Evidence:
     `dex/scripts/state.mjs:907-912`
  5. An id that does not normalise to `S<positive int>` (S01 and s1 become S1; S0 and
     `phase1` are rejected). A spec with no `:` gets an empty name. Evidence:
     `dex/scripts/state.mjs:914-921`, `dex/scripts/state.mjs:994-998`
  6. Duplicate ids after normalising. Evidence: `dex/scripts/state.mjs:934-935`
  7. Any recorded slice has a status other than `pending` and the sorted id set differs.
     Renames and reorders with the same ids pass. Evidence: `dex/scripts/state.mjs:936-945`
  8. A recorded id would be dropped and `--replace` was not given. Evidence:
     `dex/scripts/state.mjs:946-952`
- FACT: For an id already recorded, the rewrite keeps `status`, `startedAt`,
  `completedAt`, `verification` and `note` (defaults `pending`, null, null, null, null).
  `name` and `tracer` come from the new spec. `blockedBy` is not copied.
  Evidence:
  - `dex/scripts/state.mjs:913-932`
- FACT: After saving, `structureWarnings` returns non-blocking warnings. It warns when
  the structure says `Tracer bullet required: YES` and no slice is a tracer. It warns
  about S-ids that appear in only one of the structure text and the recorded list. An
  unreadable structure file gives no warnings.
  Evidence:
  - `dex/scripts/state.mjs:957`
  - `dex/scripts/state.mjs:972-992`

#### Inferences

- INFERENCE (VERIFIED): Refusal 7 runs before refusal 8. So once any slice is non-pending,
  `--replace` cannot rescue an id change.
  Based on:
  - `dex/scripts/state.mjs:939-952`

#### Unknowns

- UNKNOWN: The exact refusals inside `loadFeatureState` beyond a missing feature and a
  schema mismatch, and inside `withFeatureLock`. Resolved by reading those helpers.

### Q2: What `drift` changes, and what clears the blocked state

Verification: VERIFIED (one inference PARTIALLY VERIFIED, recorded in its corrected form)

#### Facts

- FACT: `drift` needs `--reason` and `--target` (`design` or `structure`). `--slice` is
  optional. A missing reason or bad target throws.
  Evidence:
  - `dex/scripts/state.mjs:1345-1354`
- FACT: It sets `state.blocked` to `{reason (scrubbed, max 1000 chars), target, slice
  (id or null), since (now), kind: 'design-drift'}`.
  Evidence:
  - `dex/scripts/state.mjs:1359-1365`
- FACT: With `--slice`, only that slice changes: `status = 'blocked'`,
  `blockedBy = 'drift'`. This happens whatever its current status, including `complete`.
  An unknown id fails before any change.
  Evidence:
  - `dex/scripts/state.mjs:1358`
  - `dex/scripts/state.mjs:1366-1369`
  - `dex/scripts/state.mjs:1000-1011`
- FACT: It refreshes the phase, saves, and appends `design_drift_recorded`. It never
  writes `state.approvals`, verification, AI review or code approval records.
  Evidence:
  - `dex/scripts/state.mjs:1370-1372`
  - `dex/scripts/state.mjs:480-484`
- FACT: `tryUnblock` clears the block. It needs questions, design and structure all
  approved and current. It also needs the target's `approvedAt` to be strictly later than
  `blocked.since` (an ISO string comparison). It then sets `blocked = null`. Slices with
  `status 'blocked'` and `blockedBy 'drift'` go to `in-progress` if they have
  `startedAt`, else `pending`, and lose `blockedBy`. Slices blocked by `block-slice` stay
  blocked. It logs `drift_resolved`.
  Evidence:
  - `dex/scripts/state.mjs:1391-1414`
- FACT: `tryUnblock` has two callers: `approve` (automatic) and `unblock` (throws with
  reasons when conditions fail). Nothing else sets `blocked` to null.
  Evidence:
  - `dex/scripts/state.mjs:806-808`
  - `dex/scripts/state.mjs:1416-1434`
- FACT: While blocked, `canImplement` has the blocker `feature is blocked: <reason>`,
  `finish-slice` throws, and `nextAction` returns `reapprove-<key>` for a stale document,
  else `resolve-drift` pointing at `/dex:<target>`.
  Evidence:
  - `dex/scripts/state.mjs:300`
  - `dex/scripts/state.mjs:351-366`
  - `dex/scripts/state.mjs:1069-1071`

#### Inferences

- INFERENCE (PARTIALLY VERIFIED, corrected): `drift` changes no approvals. Unblocking
  needs a fresh approval of the target after the drift, plus all three document approvals
  current. Editing the design after drift stales the structure, so the structure must be
  re-approved too. Whether questions also need re-approval is not shown.
  Based on:
  - `dex/scripts/state.mjs:1394-1404`
  - `dex/tests/gates.test.mjs:191-206`
- INFERENCE: A slice that was `complete` and is named in `drift --slice` becomes
  `blocked`. After unblock it returns to `in-progress`, because `startedAt` is set. Its
  completion is lost. No test covers this.
  Based on:
  - `dex/scripts/state.mjs:1366-1369`
  - `dex/scripts/state.mjs:1406-1410`

#### Unknowns

- UNKNOWN: Whether an approval in the same millisecond as the drift is ever produced in
  practice. The strict comparison would reject it. Resolved by a test.

### Q3: How slices are stored, and whether order means anything

Verification: VERIFIED

#### Facts

- FACT: `state.slices` is an array, created empty by `newFeatureState`. Only `state.mjs`
  reads or writes it.
  Evidence:
  - `dex/scripts/lib.mjs:664`
- FACT: Every slice has 8 fields: `id`, `name`, `tracer`, `status`, `startedAt`,
  `completedAt`, `verification`, `note`. Only `set-slices` creates slices, and it
  replaces the whole array. A 9th optional field, `blockedBy`, is added only by `drift`.
  Evidence:
  - `dex/scripts/state.mjs:893-953`
  - `dex/scripts/state.mjs:1358-1369`
- FACT: Who sets what:
  - `set-slices`: all 8 fields (`tracer` = name matches `/tracer/i`). Evidence:
    `dex/scripts/state.mjs:913-932`
  - `start-slice`: `status = 'in-progress'`, `startedAt = now`. Evidence:
    `dex/scripts/state.mjs:1050-1051`
  - `finish-slice`: `status = 'complete'`, `completedAt`, required `verification` (max
    400), optional `note` (max 1000). Evidence: `dex/scripts/state.mjs:1082-1092`
  - `block-slice`: `status = 'blocked'`, `note = reason`. No `blockedBy`. Evidence:
    `dex/scripts/state.mjs:1115-1130`
  - `drift --slice` and `tryUnblock`: see Q2.
- FACT: Status values in code: `pending`, `in-progress`, `complete`, `blocked`.
  Evidence:
  - `dex/scripts/state.mjs:212-226`
- FACT: Array order matters in three places. The "next" slice is the first `in-progress`,
  else the first `pending`, by position; `nextAction` uses it for `/dex:implement`. Status
  output lists slices in array order. `set-slices` stores the order given on the command
  line, and a pure reorder is allowed after work starts.
  Evidence:
  - `dex/scripts/state.mjs:218`
  - `dex/scripts/state.mjs:418-424`
  - `dex/scripts/state.mjs:532-535`
  - `dex/scripts/state.mjs:914-945`
- FACT: `start-slice` uses the numeric part of the id, not position. It prints a warning
  (never refuses) when a lower-numbered slice is not complete.
  Evidence:
  - `dex/scripts/state.mjs:1046-1048`
  - `dex/scripts/state.mjs:1055-1057`
- FACT: Order does not matter for gate counts, `requireAllSlicesComplete`, `findSlice`,
  `finish-slice` or `structureWarnings`.
  Evidence:
  - `dex/scripts/state.mjs:212-226`
  - `dex/scripts/state.mjs:1000-1029`
  - `dex/scripts/state.mjs:1062-1113`

#### Inferences

- INFERENCE (VERIFIED): Array order and id-number order are independent. They agree only
  if `set-slices` was given ascending ids, and nothing enforces that.
  Based on:
  - `dex/scripts/state.mjs:914-945`
  - `dex/scripts/state.mjs:1046-1048`

### Q4: Which code reads the slice list, and what it assumes

Verification: VERIFIED (two claims PARTIALLY VERIFIED, recorded in corrected form)

#### Facts

- FACT: `sliceSummary` feeds `gates.implementation`. Any length works. Zero slices gives
  MISSING. Any blocked slice gives BLOCKED. All complete gives COMPLETE. Otherwise
  IN_PROGRESS if anything is complete or in progress, else PENDING. Blocked slices are
  never "next".
  Evidence:
  - `dex/scripts/state.mjs:212-226`
- FACT: `canImplement` ignores slices. `canPr` needs implementation COMPLETE, so a
  non-empty list with every slice complete. Zero slices has its own message.
  Evidence:
  - `dex/scripts/state.mjs:294-319`
- FACT (corrected): `nextAction` first returns `resolve-drift` if blocked, then
  `reapprove-*` for stale documents, then earlier artifact and worktree steps. Only then,
  if implementation is incomplete, does it suggest `/dex:implement <slug> <next id>`. With
  no next id it suggests `/dex:implement <slug>` with "Checkpoints are not recorded yet."
  That text also appears when slices exist but all remaining ones are blocked.
  Evidence:
  - `dex/scripts/state.mjs:355-366`
  - `dex/scripts/state.mjs:418-425`
- FACT: `derivePhase` moves to `verify` when implementation is COMPLETE.
  Evidence:
  - `dex/scripts/state.mjs:464-470`
- FACT (corrected): Status output prints slices in stored order; unknown statuses print
  as PENDING. `status.mjs` appends the review guide when human code review is not approved,
  implementation is COMPLETE and verification is PASS, or when the review flag is passed.
  Evidence:
  - `dex/scripts/state.mjs:528-536`
  - `dex/scripts/status.mjs:145-149`
- FACT: `requireAllSlicesComplete` makes recording verification (pass or fail, not reset)
  and AI review fail on an empty list or any non-complete slice.
  Evidence:
  - `dex/scripts/state.mjs:1020-1029`
  - `dex/scripts/state.mjs:1162-1165`
  - `dex/scripts/state.mjs:1219`
- FACT: `start-slice` is gated on `canImplement`. It does not check the target slice's own
  status, so a complete or blocked slice can be restarted. It does not check for another
  slice already in progress.
  Evidence:
  - `dex/scripts/state.mjs:1031-1058`
- FACT: `finish-slice` needs the feature unblocked, the slice `in-progress`,
  `canImplement`, and `--verification`. It reports remaining non-complete ids.
  Evidence:
  - `dex/scripts/state.mjs:1062-1113`

#### Inferences

- INFERENCE (VERIFIED): No code assumes a fixed number of slices or contiguous ids.
  Based on:
  - `dex/scripts/state.mjs:212-226`
- INFERENCE (VERIFIED): Every later gate (PR, verification, AI review, verify phase)
  assumes a non-empty list with every slice complete.
  Based on:
  - `dex/scripts/state.mjs:306-312`
  - `dex/scripts/state.mjs:1021-1023`
  - `dex/scripts/state.mjs:469`

#### Unknowns

- UNKNOWN: Whether skill or command markdown beyond `implement` and `plan` reads the list.
  Resolved by grepping `dex/skills` and `dex/workflows`.

### Q5: How the structure approval relates to the slice list

Verification: VERIFIED (one inference PARTIALLY VERIFIED; its open part resolved below)

#### Facts

- FACT: The list is not derived from `05-structure.md`. It is built only from
  command-line specs. The structure file is read afterwards, only for warnings.
  Evidence:
  - `dex/scripts/state.mjs:893-933`
  - `dex/scripts/state.mjs:972-992`
- FACT: The structure approval stores the file's SHA-256 and an `upstream` record of the
  design hash. The slice list is not part of either.
  Evidence:
  - `dex/scripts/state.mjs:797-805`
  - `dex/scripts/state.mjs:122-157`
- FACT: The structure approval goes stale when the file hash changes or the design is
  re-approved with new content. Slices are never consulted.
  Evidence:
  - `dex/scripts/state.mjs:134-156`
- FACT: A stale or unapproved structure is a `canImplement` blocker. So `start-slice` and
  `finish-slice` refuse until the structure is re-approved. (This settles the open part
  of the Q5 inference; checked for this report.)
  Evidence:
  - `dex/scripts/state.mjs:294-301`
- FACT: An unknown slice id errors and tells the user to record slices from the approved
  structure with `set-slices`.
  Evidence:
  - `dex/scripts/state.mjs:1000-1010`

#### Inferences

- INFERENCE (corrected): The link between structure and list is convention plus warnings.
  There is no hash binding and no derivation. Editing the structure after `set-slices`
  stales the approval and blocks slice progress, but leaves `state.slices` unchanged and
  unchecked until `set-slices` runs again.
  Based on:
  - `dex/scripts/state.mjs:893-992`
  - `dex/scripts/state.mjs:294-301`

### Q6: How an existing `state.json` is loaded

Verification: VERIFIED

#### Facts

- FACT: `state.mjs` loads state only through `loadFeatureState` in `lib.mjs`. That reads
  the JSON and returns it unchanged. No defaults are filled in.
  Evidence:
  - `dex/scripts/lib.mjs:692-710`
- FACT: `state.json` has a top-level `schemaVersion` (`SCHEMA_VERSION = 1`). Any other or
  missing value throws: "Dex will not guess how to migrate engineering approvals". There
  is no migration code.
  Evidence:
  - `dex/scripts/lib.mjs:21`
  - `dex/scripts/lib.mjs:649-650`
  - `dex/scripts/lib.mjs:703-708`
- FACT: Slices have no version field. The only per-slice defaulting is in `set-slices`
  via `??`.
  Evidence:
  - `dex/scripts/state.mjs:913-932`
- FACT: Readers tolerate a missing array (`state.slices || []`, `Array.isArray`), but not
  missing slice fields.
  Evidence:
  - `dex/scripts/state.mjs:213-225`
  - `dex/scripts/state.mjs:1002-1023`
- FACT: A file that exists but does not parse throws.
  Evidence:
  - `dex/scripts/lib.mjs:268-280`
- FACT: `scanFeatures` (listing) does not check `schemaVersion`.
  Evidence:
  - `dex/scripts/lib.mjs:725-754`

#### Inferences

- INFERENCE: A new optional slice field can be added without a schema bump only if every
  reader tolerates its absence. A new required shape would need a schema change, which
  today rejects older files outright.
  Based on:
  - `dex/scripts/lib.mjs:703-708`
  - `dex/scripts/state.mjs:213-225`

#### Unknowns

- UNKNOWN: Whether a test pins the schema-mismatch error. Resolved by grepping
  `dex/tests` for "different Dex schema".

### Q7: What text advises on changing the list after work has started

Verification: VERIFIED (one inference PARTIALLY VERIFIED, recorded in corrected form)

#### Facts

- FACT: The `set-slices` started-checkpoint error says: "Dex will not change the
  checkpoints of \"<slug>\": <ids> already started." It lists Recorded and Requested ids.
  It advises: "If the structure really changed, that is design drift:
  node state.mjs drift <slug> --target structure --reason \"...\"".
  Evidence:
  - `dex/scripts/state.mjs:936-945`
- FACT: The drop error says: "This would drop recorded checkpoint(s) <ids>. If that is
  intended, repeat the command with --replace."
  Evidence:
  - `dex/scripts/state.mjs:946-952`
- FACT: The `drift` output says: "Record the evidence in <implementation log>, then revise
  the <target>: /dex:<target> <slug>. When the user approves the revised documents again,
  Dex unblocks the feature by itself."
  Evidence:
  - `dex/scripts/state.mjs:1373-1381`
- FACT: The implement skill says to STOP when the repository contradicts the design, run
  `drift` (`--target design` if the destination changed, `structure` if only the route
  changed), record the DESIGN DRIFT section, and wait for re-approval. It never mentions
  `set-slices` or changing the list.
  Evidence:
  - `dex/skills/implement/SKILL.md:90-108`
- FACT: The README says drift blocks the feature until a human revises and re-approves,
  and that Dex then unblocks by itself. It lists `unblock` as "Usually not needed:
  re-approving does it".
  Evidence:
  - `dex/README.md:290-294`
  - `dex/README.md:462-463`
- FACT: The README says "--replace allows dropping recorded ones before any has started"
  and "recorded checkpoints cannot silently disappear."
  Evidence:
  - `dex/README.md:453`
  - `dex/README.md:360-361`
- FACT: The plan skill only says to run `set-slices` with ids and names matching the plan.
  `set-slices` appears in no other skill. The structure skill has no drift or `set-slices`
  text.
  Evidence:
  - `dex/skills/plan/SKILL.md:60-67`
  - `dex/skills/structure/SKILL.md`
- FACT: The worked example's drift section (caught at S3) shows the feature blocking, the
  design being revised and re-approved, and implementation resuming. It does not show the
  checkpoint list being re-recorded.
  Evidence:
  - `dex/examples/portfolio-feature.md:660-705`

#### Inferences

- INFERENCE (corrected): Inside `set-slices`, the started-checkpoint refusal has no
  override flag. No skill, README or example text explains how to change the list once a
  checkpoint has started. Other `state.mjs` commands were not exhaustively checked for a
  way to reset started slices.
  Based on:
  - `dex/scripts/state.mjs:936-952`
- INFERENCE: Following the error's own advice does not lead back to a changed list.
  After drift is recorded and cleared, started and complete slices keep their non-pending
  status (unblock resets only the drift-blocked slice to `in-progress` or `pending`). So a
  rerun of `set-slices` with a changed id set is refused again by the same check.
  Based on:
  - `dex/scripts/state.mjs:936-945`
  - `dex/scripts/state.mjs:1406-1410`

#### Unknowns

- UNKNOWN: Whether `dex/CHANGELOG.md` or `dex/NOTES.md` record intent about this rule.
  Resolved by reading them.

### Q8: Which tests cover `set-slices`, `drift` and the blocked state

Verification: VERIFIED (one inference PARTIALLY VERIFIED, recorded in corrected form)

#### Facts

See Relevant Tests for the list. Key points on changing the list after a start:

- FACT: Once S1 is started, `set-slices S1 S2 S3 --replace` fails with `/started/`. The
  same ids with new names succeed, and S1 stays `in-progress`.
  Evidence:
  - `dex/tests/gates.test.mjs:264-271`
- FACT: After S1 is finished, re-recording the same ids keeps S1 `complete` and renames it.
  Evidence:
  - `dex/tests/state.test.mjs:266-278`

#### Inferences

- INFERENCE (corrected): No test combines `drift` with `set-slices`. The only guard that
  stops changing the id set after a start is the "started" check. It fires on any
  non-pending slice, including `blocked`. Tests exercise only `in-progress` and `complete`
  for it. No test asserts the error's drift advice text, and no test removes (rather than
  adds) an id after a start.
  Based on:
  - `dex/scripts/state.mjs:907`
  - `dex/scripts/state.mjs:938-952`

### Q9: What happens to later stages when earlier work changes

Verification: VERIFIED (three claims PARTIALLY VERIFIED, recorded in corrected form)

#### Facts

- FACT: Approvals are recomputed from file bytes on every gate computation. A changed,
  emptied or deleted approved file is STALE with `approved = false`. Nothing stores a
  "reopened" flag.
  Evidence:
  - `dex/scripts/state.mjs:122-158`
- FACT: Upstream links are one level: design records the questions hash, structure
  records the design hash. Plan, research and code have no upstream link. Plan and
  research are checked only for existence.
  Evidence:
  - `dex/scripts/state.mjs:145-162`
  - `dex/scripts/state.mjs:243-248`
  - `dex/scripts/state.mjs:798-805`
- FACT: Human code approval is bound to a git tree hash and goes stale when the tree
  changes. Verification and AI review count as not run when their recorded tree differs.
  Evidence:
  - `dex/scripts/state.mjs:173-210`
  - `dex/scripts/state.mjs:259-288`
- FACT: `canPr` includes every `canImplement` blocker. So a stale earlier approval blocks
  PR and implementation even after code is done or approved.
  Evidence:
  - `dex/scripts/state.mjs:294-319`
- FACT (corrected): `derivePhase` never moves back because of a stale questions, design
  or structure approval once implementation is complete. The phase stays verify, review
  or pr, and `complete` once a PR is recorded. Staleness shows in `canImplement`, `canPr`
  and `nextAction`, not in the phase label.
  Evidence:
  - `dex/scripts/state.mjs:464-478`
- FACT (corrected): After a PR is recorded, `nextAction` still returns `reapprove-*` or
  `resolve-drift` when a document is stale or the feature is blocked.
  Evidence:
  - `dex/scripts/state.mjs:347-375`
  - `dex/scripts/state.mjs:450-453`
- FACT: The only explicit reopening path is `drift`, described in Q2. The `design-updated`
  transition only records an event and a note.
  Evidence:
  - `dex/scripts/state.mjs:1345-1383`
  - `dex/scripts/state.mjs:845-848`

#### Inferences

- INFERENCE (VERIFIED): No code resets completed slices when an earlier document changes.
  Staleness works by gating, not by rewriting later-stage state.
  Based on:
  - `dex/scripts/state.mjs:1050`
  - `dex/scripts/state.mjs:1123`
  - `dex/scripts/state.mjs:1359-1370`
  - `dex/scripts/state.mjs:1405-1411`

#### Unknowns

- UNKNOWN: Whether the guard or PR-record command enforce stale blockers after a PR is
  recorded, and how `canPublish` behaves. Resolved by reading the guard script and
  `canPublish`.

### Q10: What the implement skill says about work found outside the structure

Verification: VERIFIED (one claim PARTIALLY VERIFIED, recorded in corrected form)

#### Facts

- FACT: No step handles work found in review or verification that is missing from the
  structure. Step 5 only says to repair the checkpoint's own failing commands and never
  to delete or skip a test.
  Evidence:
  - `dex/skills/implement/SKILL.md:72-88`
- FACT: Step 6 (drift) triggers when the repository contradicts the approved design.
  Evidence:
  - `dex/skills/implement/SKILL.md:90-108`
- FACT: Scope rule: if something outside scope must change, say so and get agreement
  first. Unrelated rewrites, renames, upgrades and architecture changes are forbidden.
  Evidence:
  - `dex/skills/implement/SKILL.md:58-70`
- FACT: The result record has fields for divergence, new discoveries and follow-up risk.
  Nothing turns discoveries into new checkpoints.
  Evidence:
  - `dex/skills/implement/SKILL.md:76-84`
  - `dex/skills/implement/SKILL.md:110-115`
- FACT (corrected): The only explicit review instruction is the `reviewCadence` sentence:
  tell the user a human should read the diff. The skill frames each per-checkpoint stop
  as a human re-steer point. It says nothing about handling review findings.
  Evidence:
  - `dex/skills/implement/SKILL.md:23-25`
  - `dex/skills/implement/SKILL.md:127-132`

#### Unknowns

- UNKNOWN: Whether the review skill, review workflow or `verification-analyzer` agent say
  what to do with findings outside the structure. Resolved by reading `dex/skills/`,
  `dex/workflows/` and `dex/agents/`.

## Existing Patterns

### Pattern: freeze by status, route change through drift

Where it appears:
- `dex/scripts/state.mjs:936-945`

What it does: once any slice is non-pending, the id set is fixed. The error redirects to
`drift --target structure`.

Where it is NOT used: nowhere else does a later-stage record refuse change based on
progress. No command re-records the list after drift.

### Pattern: staleness by content hash, enforced by gates

Where it appears:
- `dex/scripts/state.mjs:122-162` (documents, one-level upstream)
- `dex/scripts/state.mjs:173-210` (code approval by git tree)
- `dex/scripts/state.mjs:259-288` (verification and AI review by tree)

What it does: a record is recomputed as stale; it is never rewritten or deleted. Gates
then refuse.

Where it is NOT used: the slice list, the plan and research. Slice status is never
recomputed from anything.

### Pattern: carry-over by id on rewrite

Where it appears:
- `dex/scripts/state.mjs:913-932`

What it does: `set-slices` keeps progress fields for matching ids and defaults new ids.

Where it is NOT used: `blockedBy` is dropped on rewrite.

### Pattern: tagged block with automatic release

Where it appears:
- `dex/scripts/state.mjs:1366-1369` (`blockedBy: 'drift'`)
- `dex/scripts/state.mjs:1406-1410` (release only drift-tagged slices)

What it does: marks who blocked a slice so only that cause releases it.

Where it is NOT used: `block-slice` sets no tag, so its slices are never auto-released.

### Pattern: soft advisory warnings

Where it appears:
- `dex/scripts/state.mjs:972-992` (structure vs list)
- `dex/scripts/state.mjs:1046-1057` (start out of id order)

What it does: prints a note and never refuses.

### Pattern: fail-closed blocker lists

Where it appears:
- `dex/scripts/state.mjs:290-319`

What it does: collects every refusal reason; an empty list is the only grant.

## Relevant Tests

- `dex/tests/gates.test.mjs:264-271` — after S1 starts, an id-set change fails `/started/`
  even with `--replace`; same-id rename passes and keeps S1 `in-progress`.
- `dex/tests/gates.test.mjs:257-262` — before any start, dropping S2 needs `--replace`.
- `dex/tests/gates.test.mjs:273-278` — id normalising and duplicate rejection.
- `dex/tests/state.test.mjs:259-278` — id format; rename after S1 complete keeps it `complete`.
- `dex/tests/state.test.mjs:185-190` — `set-slices` refused while structure is DRAFT.
- `dex/tests/gates.test.mjs:176-212` — drift blocks; unblock needs fresh approval; design
  revision forces structure re-approval.
- `dex/tests/gates.test.mjs:214-219`, `250-255` — `finish-slice` refused while blocked;
  bad drift inputs rejected.
- `dex/tests/gates.test.mjs:221-231` — drift-blocked S1 returns to `pending`; S2 blocked by
  `block-slice` stays blocked.
- `dex/tests/gates.test.mjs:233-239` — structure-target drift points to `/dex:structure`;
  phase updates.
- `dex/tests/state.test.mjs:516-544` — drift sets `canImplement` false and
  `resolve-drift`; unblock after design and structure approval.
- `dex/tests/guard.test.mjs:290-297` — guard denies code edits while blocked.
- `dex/tests/workflows-run.test.mjs:179-195` — tracer and id-mismatch warnings.

Not covered: `drift` combined with `set-slices`; `drift --slice` on a complete slice;
removing an id after a start; the started-error advice text; schema mismatch (unconfirmed).

## Relevant Configuration

- `dex/scripts/lib.mjs:62-71` — `DEFAULT_CONFIG`. `strictGates: true` makes `set-slices`
  require an approved structure. `reviewCadence: 'final'` (also `slice`, `checkpoint`)
  controls when the implement skill asks for human review.
- `dex/scripts/lib.mjs:21` — `SCHEMA_VERSION = 1`; any other value in `state.json` is refused.

## Relevant Dependencies

- Node built-ins only (`node:fs`, `node:path`, `node:os`, `node:crypto`,
  `node:child_process`, `node:url`) in `dex/scripts/state.mjs:14-19`. No package manifest
  in `dex/`.
- git — tree hashes for code approval, verification and AI review
  (`dex/scripts/state.mjs:173-210`).

## Contradictions / Ambiguities

- The `set-slices` error says a changed structure "is design drift" and points to
  `drift --target structure`. But after drift is resolved, started slices are still
  non-pending, so the same `set-slices` call is refused again. The advised route has no
  documented end that changes the list. (`dex/scripts/state.mjs:936-945`,
  `dex/scripts/state.mjs:1406-1410`)
- The `set-slices` error names only `--target structure`. The implement skill says
  `--target design` when the destination changed. (`dex/scripts/state.mjs:943`,
  `dex/skills/implement/SKILL.md:90-99`)
- README says `--replace` works "before any has started". The code's rule is stricter in
  one way and looser in another: it freezes on any non-pending slice (including
  `blocked`), but still allows renames and reorders. (`dex/README.md:453`,
  `dex/scripts/state.mjs:936-952`)
- The "started" check counts a `blocked` slice as started. A slice blocked by
  `block-slice` before ever starting freezes the list. (`dex/scripts/state.mjs:938-945`)
- `drift --slice` on a complete slice sets it `blocked`; unblock then makes it
  `in-progress`, so a finished checkpoint loses its completion. The skill passes
  `--slice <id>` without saying which slice. (`dex/scripts/state.mjs:1366-1369`,
  `dex/scripts/state.mjs:1406-1410`, `dex/skills/implement/SKILL.md:90-99`)
- "Next" uses array order; the `start-slice` warning ("ordered for a reason") uses id
  number. They can disagree, and reorders are allowed after a start.
  (`dex/scripts/state.mjs:218`, `dex/scripts/state.mjs:1046-1048`)
- The slice list and the structure approval are linked only by convention and warnings.
  Re-approving a revised structure does not check or update the list.
  (`dex/scripts/state.mjs:797-805`, `dex/scripts/state.mjs:972-992`)
- `derivePhase` keeps a late phase (verify, review, pr, complete) while `nextAction`
  returns `reapprove-*` for a stale earlier document. The code comment says deriving the
  phase prevents disagreement. (`dex/scripts/state.mjs:461-478`,
  `dex/scripts/state.mjs:347-375`)
- "Checkpoints are not recorded yet" is shown when checkpoints exist but all remaining are
  blocked. (`dex/scripts/state.mjs:418-425`)
- `block-slice` sets no `blockedBy`, and `set-slices` drops `blockedBy`. A drift-blocked
  slice re-recorded by `set-slices` loses its tag and is not auto-released.
  (`dex/scripts/state.mjs:913-932`, `dex/scripts/state.mjs:1115-1130`)
- `start-slice` restarts a complete or blocked slice without checking its status.
  (`dex/scripts/state.mjs:1031-1058`)
- `loadFeatureState` enforces `schemaVersion`; `scanFeatures` does not. A mismatched
  feature is listed but fails to load. (`dex/scripts/lib.mjs:703-708`,
  `dex/scripts/lib.mjs:725-754`)
- The implement skill gives no route for review or verification findings that fall
  outside the structure. (`dex/skills/implement/SKILL.md:72-132`)

## Research Confidence

High-confidence areas:

- `set-slices` refusals and carry-over; `drift` and `tryUnblock` behaviour; slice fields
  and who sets them; order semantics; structure-vs-list link; load and schema handling;
  gate and next-action logic. All verified against code.

Low-confidence areas:

- Whether a design-target drift forces questions re-approval (not shown).
- Other `state.mjs` commands were not exhaustively checked for a way to reset started slices.
- Review skill, workflows, agents, CHANGELOG and NOTES were not read for guidance on
  findings outside the structure.
- Guard and `canPublish` behaviour after a PR is recorded.
- Whether a test pins the schema-mismatch error.

## Files Most Relevant to Design

- `dex/scripts/state.mjs` (`set-slices` 893-998, `drift`/`tryUnblock`/`unblock` 1345-1434,
  `sliceSummary` 212-226, `computeGates` 290-319, `nextAction` 347-453, `derivePhase` 461-484,
  slice commands 1000-1130)
- `dex/scripts/lib.mjs` (state shape 640-710, config 55-75)
- `dex/skills/implement/SKILL.md`
- `dex/skills/plan/SKILL.md`
- `dex/README.md` (290-294, 360-361, 453, 462-463)
- `dex/tests/gates.test.mjs` (176-278)
- `dex/tests/state.test.mjs` (185-278, 516-544)
