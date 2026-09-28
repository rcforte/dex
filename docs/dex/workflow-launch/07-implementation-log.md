# Implementation Log: Workflow launch from plugin

> Appended once per checkpoint. Concise: this is the compaction artifact a fresh
> context reads instead of replaying the whole session.

## S1: Research launches from staged copy (tracer)

Status: IMPLEMENTED

### Changes

- `lib.mjs`: added `WORKFLOW_NAMES`, `WORKFLOWS_DIR`, and `stageWorkflow(root, config, name)`.
  It copies the file to `<stateRoot>/_workflows/<name>.js`, overwriting any old
  copy. It also hides the state folder from git.
- `state.mjs`: added the `stage-workflow <research|review> [--json]` command and its
  usage line.
- The research skill now stages the workflow, then launches from the printed path.
  It stops if staging fails.
- Test "finding 22" now requires the staging step for research. Review keeps the
  old wording until S2.
- Seven new state tests: a byte-identical copy for both workflows, overwrite,
  custom `stateRoot`, an unknown name, not listed as a feature, and git status
  clean without init.

### Files

- `dex/scripts/lib.mjs`, `dex/scripts/state.mjs`, `dex/skills/research/SKILL.md`,
  `dex/README.md`, `dex/tests/state.test.mjs`, `dex/tests/workflows-run.test.mjs`

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 291 pass, 0 fail.

Live tracer: `state.mjs stage-workflow research` printed
`/home/rcforte/dev/code/dex-harness/.dex/_workflows/research.js`. The Workflow tool
launched that path with no path error. The workflow ran one agent and returned
its own refusal, `ok: false` ("Dex has no feature named \"no-such-feature\"").
This confirms the tool accepts a script inside the hidden `.dex/` folder.

### Divergence from plan

- The README command table row for `stage-workflow` was added now instead of in
  S4. Two existing docs tests require every state.mjs command, and every command
  a skill names, to be documented.

### New discoveries

- Run from the feature worktree, `stage-workflow` resolved the project root to the
  main repository, because `findRepoRoot` finds `.dex/` there. That is correct for
  how skills run. Note that the copy comes from whichever plugin folder ran the
  command.
- A separate Dex bug, out of scope: the guard blocks `git commit` before a
  worktree exists, while `/dex:worktree` refuses to run with uncommitted changes.
  The user had to commit by hand.

### Follow-up risk

- Only the path shape is proven live. A full research run from the copy happens in
  the sample-project live check (S4).

## S2: Review launches the same way

Status: IMPLEMENTED

### Changes

- The review skill stages `review` and launches from the printed path. `args` are unchanged.
- Both skills now say what to do when the Workflow tool refuses to start the
  script: stop, report the message, and suggest `/dex:doctor`. There is no
  fallback to subagents and no pasting the script inline.
- Test "finding 22" applies the staging assertions to both skills, plus a check
  for the refused-launch line.

### Files

- `dex/skills/review/SKILL.md`, `dex/skills/research/SKILL.md`, `dex/tests/workflows-run.test.mjs`

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 291 pass, 0 fail. `stage-workflow review` printed
`/home/rcforte/dev/code/dex-harness/.dex/_workflows/review.js`.

### Divergence from plan

- The refused-launch line sits just before "When the result arrives", not inside
  it. A refused launch happens before any result exists.

### New discoveries

- The S2 stop condition did not trigger. The review skill runs `state.mjs` from
  the main repository, and `stage-workflow` resolves there even when invoked
  from the worktree.

### Follow-up risk

- There is no live review launch until the sample-project check.

## S3: Doctor catches unlaunchable setup

Status: IMPLEMENTED

### Changes

- `doctor.mjs` adds a `Workflow <name> staging` check for each workflow. It calls
  `stageWorkflow` for real. It passes only when the copy lands inside the
  repository root, and fails with the copy error otherwise.
- The parse checks and `workflow.test.mjs` now use the shared `WORKFLOW_NAMES`
  list instead of their own hard-coded ones.
- Test "finding 31" narrowed as the human decided. Doctor may create only
  `.dex/_workflows/research.js` and `review.js`. It creates no `docs/`, and
  `git status` stays clean.
- Two new doctor tests: both staging checks pass in a normal repository, and
  both fail when `.dex` is a file.

### Files

- `dex/scripts/doctor.mjs`, `dex/tests/hygiene.test.mjs`, `dex/tests/workflow.test.mjs`

### Verification

Command: `node --test dex/tests/*.test.mjs` and `node dex/scripts/doctor.mjs`

Result: 293 pass, 0 fail. Doctor shows both staging checks PASS and "Ready."

### Divergence from plan

- The planned "config did not load" failure was not added. Doctor already falls
  back to the default config when loading fails (`doctor.mjs:197-200`), and the
  default state folder is always inside the repository, so staging still means
  something.

### New discoveries

None.

### Follow-up risk

- Doctor now writes into any repository it inspects. This was the human's
  decision, and it reverses part of the earlier "doctor writes nothing" fix.

## S4: Docs and live-check entry

Status: IMPLEMENTED

### Changes

- README: `_workflows/` added to the `.dex/` tree, plus a short paragraph on why
  the copies exist and who refreshes them. The command table row was added in S1.
- CHANGELOG: a `0.2.1` entry under Fixed. `plugin.json` version bumped to `0.2.1`.
- LIVE-CHECKS: an unchecked Step 6 item for the sample project, covering both
  launches with no workaround, both doctor staging checks PASS, and a clean git
  status.

### Files

- `dex/README.md`, `dex/CHANGELOG.md`, `dex/.claude-plugin/plugin.json`, `dex/tests/LIVE-CHECKS.md`

### Verification

Command: `node --test dex/tests/*.test.mjs`

Result: 293 pass, 0 fail, including the version and changelog match.

### Divergence from plan

None.

### New discoveries

None.

### Follow-up risk

- The real proof in another project is still the unchecked live-check item. A
  human runs it in `~/dev/code/dex-sample`.

## DESIGN DRIFT

Checkpoint: after S4, raised by the AI review (`08-review.md` M1, M2)

Discovery: "Inside the project" was defined as the main checkout. A Claude Code
session opened in a linked worktree has that worktree as its project, and the
main checkout is outside it. The copy lands in the main checkout's `.dex/`, and
the Workflow tool would refuse it. Doctor checks the copy against the same main
checkout, so it reports PASS. Separately, doctor's containment check compares
paths without resolving symlinks, so it cannot fail.

Evidence:

- `dex/scripts/lib.mjs:124-157` — `findRepoRoot` deliberately returns the main
  checkout from inside a worktree.
- `dex/scripts/state.mjs` `COMMANDS['stage-workflow']` and `doctor.mjs` staging
  check both stage under that root.
- `dex/scripts/doctor.mjs` staging check uses `path.relative` on unresolved
  paths. `loadConfig` (`lib.mjs:393-398`) already rules out every value that
  could make it fail.

Impact: the feature's goal ("launches in any project") fails for worktree
sessions. Doctor gives a false PASS there and for a symlinked `.dex`.

Required action: return to design

## S5: Copy follows session checkout; doctor compares real paths

Status: IMPLEMENTED. Not recorded as a checkpoint in Dex state: `set-slices`
refuses to add a checkpoint once others have started. The human agreed to do
this as review remediation, logged here.

### Changes

- `lib.mjs`: new `sessionTop(cwd, root)`, which returns the git top level of the
  session's folder, or the Dex root outside git. `stageWorkflow` takes
  `{ cwd }` and stages under `sessionTop`. Dex state still resolves to the main
  checkout.
- `state.mjs`: `stage-workflow` passes `ctx.cwd`.
- `doctor.mjs`: stages with `cwd`. It compares the `realpathSync` of the copy
  against the session top. The inside test now rejects only `..` or `../…`,
  which also fixes review L2.
- README: one sentence on worktree sessions.
- Tests: `stage-workflow` from a linked worktree copies there, keeps
  `git status` clean, and still sees the main checkout's features. Doctor from a
  worktree passes, with copies in the worktree. Doctor with `.dex` symlinked
  outside the repository reports FAIL.

### Files

- `dex/scripts/lib.mjs`, `dex/scripts/state.mjs`, `dex/scripts/doctor.mjs`,
  `dex/README.md`, `dex/tests/state.test.mjs`, `dex/tests/hygiene.test.mjs`

### Verification

Command: `node --test dex/tests/*.test.mjs` and `node dex/scripts/doctor.mjs`

Result: 296 pass, 0 fail. Doctor shows both staging checks PASS.

### Divergence from plan

- The work was done without a recorded checkpoint (see Status).

### New discoveries

- Dex gap: after design drift adds a checkpoint to the structure, `set-slices`
  cannot record it, because earlier checkpoints have started.

### Follow-up risk

- Review L1 (doctor outside git leaves `.dex/`) and L3 (no guard test for
  `stage-workflow`) remain open by decision.
