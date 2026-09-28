# Tactical Plan: Workflow launch from plugin

> This artifact exists for the implementation agent, not for the human reviewer.
> Spot-check it for obvious divergence. Do not substitute reading it for
> reading the production code.
>
> Reference exact files and symbols. Do not write method bodies here.

## Approved Inputs

- Design: `04-design.md`
- Structure: `05-structure.md`

## Ground Rules

1. Read the current code before editing it. The plan can be stale; code is truth.
2. If the repository contradicts the approved design, stop and record design drift.
3. Do not touch anything outside the checkpoint's stated files without surfacing it.
4. Full test suite, used as the verification command throughout:
   `node --test dex/tests/*.test.mjs` (`dex/README.md:513`).

## Decisions made after structure approval

- **Doctor writes the staged copies.** The human chose this knowing it reverses
  finding 31 ("doctor writes nothing into the repository",
  `dex/tests/hygiene.test.mjs:169-174`, fixed in `ec315a8`). S3 narrows that test
  rather than deleting it.
- **Only the two workflows are staged.** Scripts, templates, and hooks keep running
  from the plugin folder through Bash, which has no path limit.
- **Staging also hides the state folder from git.** `stageWorkflow` calls the
  existing `ignoreStateRoot`. Otherwise doctor, run in a repository where Dex was
  never initialised, would leave `.dex/_workflows/` showing in `git status`. That
  would break the design's "hidden from git" promise.

## Checkpoint S1: Research launches from a staged copy (tracer)

### Objective

`/dex:research` copies its workflow into `<stateRoot>/_workflows/research.js` and
launches from there. A live launch in this session proves the Workflow tool
accepts that path.

### Preconditions

- Structure approved (it is).
- The full suite passes on the starting commit.

### Files

#### `dex/scripts/lib.mjs`

Change: add exported `WORKFLOW_NAMES = ['research', 'review']`, `WORKFLOWS_DIR`, and
`stageWorkflow(root, config, name)`.
- Resolve `WORKFLOWS_DIR` from this file's own location, next to `PRE_PUSH_SCRIPT`.
- `stageWorkflow` rejects names not in `WORKFLOW_NAMES` with a `DexError` that
  lists the valid names.
- It creates `<root>/<config.stateRoot>/_workflows/` and copies the file over any
  existing copy. Use a byte copy, not a read and rewrite.
- It calls `ignoreStateRoot(root, config)` and returns `{ path }` with an absolute
  path.
- It wraps filesystem errors in a `DexError` that says what could not be written.

Why: this is the one place both the command and doctor use.

Relevant symbols: `PRE_PUSH_SCRIPT` (lib.mjs:920), `stateRootDir` (lib.mjs:158),
`ignoreStateRoot` (lib.mjs:825), `DexError` (lib.mjs:84).

#### `dex/scripts/state.mjs`

Change:
- Add `COMMANDS['stage-workflow']` next to `COMMANDS['diff-hash']`
  (state.mjs:1482). It takes one positional name and `--json`.
- Text output is the absolute path alone. JSON output is `{ name, path }`.
- Add a usage line to the header comment:
  `node state.mjs stage-workflow <research|review>   copy a workflow into the project so the Workflow tool can load it`.
- Import `stageWorkflow` from `./lib.mjs`.

Why: skills reach Dex only through state.mjs.

Relevant symbols: `COMMANDS` (state.mjs:603), `parseFlags` (state.mjs:563), `run`
(state.mjs:1524). `run` already passes `root` and `config`.

#### `dex/skills/research/SKILL.md`

Change: in "## 2. Run the research workflow" (line 26), before the Workflow block:
- Add a step that runs
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" stage-workflow research`.
- Change the block to `scriptPath: <the path stage-workflow printed>`.
- Keep every `args` key unchanged.
- Add one sentence explaining why: the Workflow tool only loads scripts from
  inside the project.
- If `stage-workflow` fails, stop and report its message.

Do not touch the fallback section yet (S2 adds the refused-launch line to both
skills together).

#### `dex/tests/workflows-run.test.mjs`

Change: rewrite test "finding 22" (lines 44-53) for research only in this
checkpoint. The skill must contain `state.mjs" stage-workflow research`. It must
not match `scriptPath: ${CLAUDE_PLUGIN_ROOT}`. It must still match `scriptPath:`
and not `Workflow tool, script:`. Keep the `args` key assertions. Leave review's
assertions on the old wording until S2.

#### `dex/tests/state.test.mjs`

Change: add a "Staging workflows" section. Use `makeRepo`, `state`, and
`stateFails` from `helpers.mjs`.

### Implementation Steps

1. Add `WORKFLOW_NAMES`, `WORKFLOWS_DIR`, and `stageWorkflow` to lib.mjs.
2. Add the `stage-workflow` command and its usage line.
3. Write the state tests (below) and make them pass.
4. Update the research skill and rewrite finding 22 for research.
5. Run the full suite.
6. Live tracer (run by the implementing agent in this session):
   - Run `node dex/scripts/state.mjs stage-workflow research` from the repository
     root.
   - Launch the Workflow tool with `scriptPath` set to the printed path, and args
     `{"slug":"no-such-feature","maxWorkers":1,"stateScript":"<abs>/dex/scripts/state.mjs","templatesDir":"<abs>/dex/templates","artifactRoot":"docs/dex","stateRoot":".dex"}`.
   - Record the outcome in `07-implementation-log.md`.

### Tests

1. `stage-workflow research` in a fresh `makeRepo()` prints a path equal to
   `<root>/.dex/_workflows/research.js`. That file is byte-identical to
   `dex/workflows/research.js`.
2. The same holds for `review`.
3. After overwriting the copy with junk, running the command again restores it.
4. With `.dex/config.json` setting `stateRoot` to `state`, the copy lands in
   `<root>/state/_workflows/`.
5. `stateFails(root, ['stage-workflow', 'bogus'])` fails, and its message names
   `research` and `review`.
6. After staging, `list` reports no feature named `_workflows`.
7. After staging in a repository where `init` never ran,
   `git status --porcelain` is empty.

### Verification Commands

```bash
node --test dex/tests/*.test.mjs
node dex/scripts/state.mjs stage-workflow research
```

### Expected Observable Result

- The suite is green.
- The command prints `/home/rcforte/dev/code/dex-harness/.dex/_workflows/research.js`.
- The live launch returns the workflow's own result, `ok: false` with a reason
  about the questions gate, after one agent. The tool reports no path error.

### Stop Conditions

Stop and return to design if:

- The Workflow tool refuses the staged path. Do not switch to passing the script
  inline.
- The Dex guard refuses `state.mjs stage-workflow`. Do not weaken the guard.
- `ignoreStateRoot` cannot be reused as-is, for example because it needs a
  feature to exist.

## Checkpoint S2: Review launches the same way

### Objective

`/dex:review` stages and launches like research. Both skills say what to do when
the tool refuses the launch.

### Preconditions

S1 complete, including a successful live tracer.

### Files

#### `dex/skills/review/SKILL.md`

Change: in "## 3. Run the review workflow" (line 41), make the same edit as
research. Stage with `stage-workflow review`, then launch with
`scriptPath: <the path stage-workflow printed>`. Keep `args` unchanged.

#### `dex/skills/research/SKILL.md` and `dex/skills/review/SKILL.md`

Change: add one short bullet next to "When the result arrives". If the Workflow
tool itself refuses to start the script, stop, report its message, and suggest
`/dex:doctor`. Do not fall back to subagents, and do not paste the script inline.

#### `dex/tests/workflows-run.test.mjs`

Change: extend finding 22 to review, with the same assertions. Add an assertion
that both skills mention `/dex:doctor` in the refused-launch line.

### Implementation Steps

1. Edit the review skill.
2. Add the refused-launch bullet to both skills.
3. Extend finding 22.
4. Run the full suite.

### Tests

1. Finding 22 covers both skills.
2. `skills-cli.test.mjs` ("every state.mjs command used by a skill or workflow
   exists") passes with no change, since the command now exists.

### Verification Commands

```bash
node --test dex/tests/*.test.mjs
node dex/scripts/state.mjs stage-workflow review
```

### Expected Observable Result

The suite is green. The command prints `.../.dex/_workflows/review.js`.

### Stop Conditions

- Stop if the review skill launches from somewhere other than the main
  repository, for example from inside the feature worktree. The staged path would
  then be relative to a different root. Return to structure.

## Checkpoint S3: Doctor catches an unlaunchable setup

### Objective

`/dex:doctor` stages each workflow for real. It fails when staging fails or when
the copy would land outside the repository.

### Preconditions

S2 complete.

### Files

#### `dex/scripts/doctor.mjs`

Change:
- Replace the hard-coded `['research.js', 'review.js']` loop (doctor.mjs:175-178)
  with a loop over `WORKFLOW_NAMES`. It keeps the existing `checkWorkflow` parse
  check.
- For each name, add a check named `Workflow <name> staging`:
  - Call `stageWorkflow(root, config, name)`.
  - PASS when it returns a path inside `root`.
  - FAIL with the error message when it throws, or when the path resolves outside
    `root`.
  - Run it only after `config` has loaded (doctor.mjs:194). If config failed to
    load, report FAIL with "config did not load".

Why: this makes doctor fail exactly where the launch would fail.

Relevant symbols: `checkWorkflow` (doctor.mjs:74), `runDoctor` (doctor.mjs:~182),
`add`, `root`, `config`, `PASS`, `FAIL`.

#### `dex/tests/hygiene.test.mjs`

Change: replace "finding 31: doctor writes nothing into the repository" with
"doctor writes only its staged workflows". After `runDoctor({ cwd: root })`:
- Under `.dex/`, only `_workflows/research.js` and `_workflows/review.js` exist.
  There is no `config.json` and no `active`.
- `docs/` does not exist.
- `git status --porcelain` is empty.

Update the file header comment ("doctor looks without writing") to match.

#### `dex/tests/workflow.test.mjs`

Change: `WORKFLOWS` (line 21) is derived from `WORKFLOW_NAMES` imported from
`../scripts/lib.mjs`.

#### Doctor staging tests

Add them to `hygiene.test.mjs` next to the finding 31 replacement:
1. In a fresh `makeRepo()`, both `Workflow <name> staging` checks are PASS.
2. When `<root>/.dex` is an existing file (not a folder), both are FAIL, and the
   overall doctor result fails. This simulates a state folder that cannot be
   written, portably.

### Implementation Steps

1. Import `WORKFLOW_NAMES` and `stageWorkflow` into doctor.mjs, and add the check.
2. Update `workflow.test.mjs` to use the shared list.
3. Replace the finding 31 test and add the two staging tests.
4. Run the full suite, then `node dex/scripts/doctor.mjs` in this repository.

### Verification Commands

```bash
node --test dex/tests/*.test.mjs
node dex/scripts/doctor.mjs
```

### Expected Observable Result

Doctor output includes `Workflow research staging  PASS` and
`Workflow review staging  PASS`.

### Stop Conditions

- Stop if doctor's config loading can point `stateRoot` outside `root`. The
  containment rule in `loadConfig` (lib.mjs:393-398) is what makes staging safe.
  If that rule does not hold, return to design.

## Checkpoint S4: Docs and live-check entry

### Objective

Document the staged folder, bump the patch version, and hand the real launch to
the human's sample-project check.

### Files

#### `dex/README.md`

Change: in "## Files Dex creates in your repository" (around line 367), add
`_workflows/` to the `.dex/` tree with a short gloss. Add one sentence explaining
it is a copy of the plugin's workflow scripts, refreshed on every launch and by
`/dex:doctor`, because the Workflow tool only loads scripts from inside the
project.

#### `dex/CHANGELOG.md` and `dex/.claude-plugin/plugin.json`

Change: add a `## [0.2.1] — 2026-09-28` entry under `### Fixed`. It says research
and review now launch in any project, and doctor now writes `.dex/_workflows/`.
Set `version` to `0.2.1`.

#### `dex/tests/LIVE-CHECKS.md`

Change: add an unchecked item. In `~/dev/code/dex-sample`, `/dex:research` and
`/dex:review` launch with no path error and no hand workaround, and
`/dex:doctor` shows both staging checks PASS.

Note: this file already has uncommitted changes from before this feature. Add to
it; do not revert or rewrite those changes.

### Implementation Steps

1. Edit the README, changelog, and manifest version.
2. Add the live-check item.
3. Run the full suite.

### Verification Commands

```bash
node --test dex/tests/*.test.mjs
```

### Expected Observable Result

The suite is green, including the version and changelog match in `docs.test.mjs`.

### Stop Conditions

- Stop if `docs.test.mjs` requires something about the README that the new
  folder breaks, such as a fixed tree listing. Surface it; do not loosen the test.
