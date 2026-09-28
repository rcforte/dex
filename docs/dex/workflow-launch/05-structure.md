# Program Structure: Workflow launch from plugin

> Answers one question: HOW DO WE GET THERE IN SAFE, OBSERVABLE STEPS?
> Closer to header files than to code: types, signatures, file locations,
> call flow, execution order, verification points. No implementation bodies.
> Requires explicit human approval.

## Approved Design

Reference: `04-design.md`

## Change Surface

### Existing files modified

- `dex/scripts/lib.mjs` — adds the known workflow names, the plugin's workflow
  folder, and the staging function. It finds the plugin folder from its own file
  location, the same way it already finds `pre-push.mjs` (`lib.mjs:920`).
- `dex/scripts/state.mjs` — adds the `stage-workflow` command and its line in the
  usage header.
- `dex/scripts/doctor.mjs` — replaces the hard-coded workflow list with the shared
  one. Adds one "can be staged" check per workflow.
- `dex/skills/research/SKILL.md` — a staging step before launch. `scriptPath` is
  now the staged path. One line covers a refused launch.
- `dex/skills/review/SKILL.md` — the same changes.
- `dex/tests/workflows-run.test.mjs` — rewrites the test that locks in the old
  wording ("finding 22").
- `dex/tests/workflow.test.mjs` — uses the shared workflow list instead of its own.
- `dex/README.md` — one sentence on `.dex/_workflows/`, where the state folder is
  described.
- `dex/CHANGELOG.md` and `dex/.claude-plugin/plugin.json` — a patch version entry.
  A test requires the two to match.

### New files

- None in the plugin. At run time, `<stateRoot>/_workflows/research.js` and
  `review.js` appear in the user's project.

### Deleted files

- None.

## Important Types

```text
WORKFLOW_NAMES      ['research', 'review']   — the only names that can be staged
WORKFLOWS_DIR       <plugin>/workflows       — the source, resolved from lib.mjs's own location
STAGED_DIR          '_workflows'             — folder name under stateRoot; cannot be a feature name
```

## Important Interfaces

```text
lib.mjs
  { path: string } stageWorkflow(root, config, name)
      Copies WORKFLOWS_DIR/<name>.js to <root>/<stateRoot>/_workflows/<name>.js,
      overwriting. Returns the absolute path of the copy.
      Throws DexError on an unknown name or a failed copy.

state.mjs
  node state.mjs stage-workflow <research|review> [--json]
      text: the absolute path, alone on the line
      json: { name, path }
      Needs no feature and no gate. Unknown name -> non-zero exit and the list of valid names.

doctor.mjs
  check "Workflow <name> staging" : PASS when stageWorkflow succeeds and the returned
                                    path is inside the repository root; FAIL otherwise.
```

## End-to-End Call Flow

```text
/dex:research <slug>
  -> skill: state.mjs check <slug>                        (unchanged)
  -> skill: state.mjs stage-workflow research
       -> lib.stageWorkflow(root, config, 'research')
       -> prints <project>/.dex/_workflows/research.js
  -> skill: Workflow { scriptPath: <printed path>, args: unchanged }
  -> workflow runs as today
```

## Testing Strategy

### Existing tests extended

- `workflows-run.test.mjs`, "finding 22" becomes: each skill runs
  `stage-workflow <name>` before launch. Each skill's `scriptPath` is not under
  `${CLAUDE_PLUGIN_ROOT}`. The existing `args` key checks stay.
- `skills-cli.test.mjs` already fails if a skill calls a state.mjs command that
  does not exist. It covers the new command with no change.
- `workflow.test.mjs` uses the shared name list.

### New unit tests

In `state.test.mjs`, run from a temporary repository whose folder is outside the
plugin:
- `stage-workflow research` prints a path inside the temporary repository, and
  the file is byte-identical to `dex/workflows/research.js`. The same for `review`.
- Running it twice overwrites the copy. A copy edited by hand is restored.
- A custom `stateRoot` puts the copy under that folder.
- `stage-workflow bogus` fails and names the valid workflows.
- `list` and `status` do not report `_workflows` as a feature.

In the doctor tests (wherever doctor is tested today):
- The staging check passes in a normal temporary repository.
- The staging check fails when the state folder cannot be written.

### Integration tests

- None beyond the above. Node cannot call the real Workflow tool.

### End-to-end tests

- Live, in this session (S1): stage research, then launch it with a feature name
  that does not exist. It passes when the tool accepts the path and the workflow
  returns its own `ok: false` gate refusal after one agent.
- Live, in `~/dev/code/dex-sample` (added to `LIVE-CHECKS.md`, run by the human):
  `/dex:research` and `/dex:review` launch with no path error and no hand
  workaround.

## Implementation Shape

Tracer bullet required: YES

Reason: the whole design rests on one unconfirmed fact. The Workflow tool must
accept a script path inside a hidden folder (`.dex/`). That is known only from one
live observation of the opposite case. If it is false, every later step is wasted.

Uncertainty the tracer resolves: does the Workflow tool accept
`<project>/.dex/_workflows/<name>.js`?

### Checkpoint S1 — Research launches from a staged copy (tracer)

Objective: prove the full path for research: stage the file, launch it, and the
tool accepts it.

Vertical path:

```text
research skill -> state.mjs stage-workflow -> lib.stageWorkflow -> .dex/_workflows/research.js -> Workflow tool accepts it
```

Implementation depth: production code, not a stub. It covers `stageWorkflow`,
the `stage-workflow` command, and the research skill's launch step. It includes
the unit tests for research staging, and "finding 22" rewritten for research.

Verification:
- `node --test dex/tests/` passes.
- The live launch in this session with a nonexistent feature name returns the
  workflow's own `ok: false`. It must not return a path error from the tool.

Expected approximate change surface: `lib.mjs`, `state.mjs`, the research skill,
two test files.

### Checkpoint S2 — Review launches the same way

Objective: `/dex:review` uses the same staging step and handles a refused launch.

Vertical path:

```text
review skill -> state.mjs stage-workflow review -> .dex/_workflows/review.js -> Workflow
```

Implementation depth: the review skill text, "finding 22" extended to review, the
review staging unit test, and the refused-launch line in both skills.

Verification: `node --test dex/tests/` passes. `stage-workflow review` run by hand
prints a path under `.dex/_workflows/`. No live review launch is needed here: it
needs a finished diff, and S1 already proved the tool accepts the path shape.

### Checkpoint S3 — Doctor catches an unlaunchable setup

Objective: `/dex:doctor` fails where staging fails, instead of passing on a parse
check alone.

Vertical path:

```text
/dex:doctor -> doctor.mjs -> lib.stageWorkflow for each name -> PASS/FAIL line
```

Verification: the two doctor tests above. `node dex/scripts/doctor.mjs` in this
repository shows the two new PASS lines.

### Checkpoint S4 — Docs and live-check entry

Objective: the change is documented and handed to the human's live check.

Verification: `docs.test.mjs` passes, which covers the version and changelog
match. `LIVE-CHECKS.md` has an unchecked item for both launches in the sample
project.

### Checkpoint S5 — Copy follows the session's checkout; doctor compares real paths

Added after design drift (AI review M1, M2).

Objective: from a session inside a linked worktree, `stage-workflow` and doctor
put the copy in that worktree. Doctor fails when the copy's real path is outside
the session checkout.

Vertical path:

```text
worktree session -> state.mjs stage-workflow -> lib.stageWorkflow(root, config, name, { cwd })
  -> <worktree>/.dex/_workflows/<name>.js -> doctor real-path check against the same checkout
```

Interface change:

```text
lib.mjs
  { path } stageWorkflow(root, config, name, { cwd } = {})
      Stages under the git top level of `cwd` when inside git. Otherwise under `root`.
  string  sessionTop(cwd, root)      — that folder, exported for doctor
```

`COMMANDS['stage-workflow']` and doctor pass their `cwd`. Doctor compares
`fs.realpathSync` of the copy against `fs.realpathSync(sessionTop)`. Its inside
test is `rel !== '..' && !rel.startsWith('..' + sep)`, which also fixes review L2.

Verification (tests in `state.test.mjs` and `hygiene.test.mjs`):
- From a linked worktree made by `git worktree add`, `stage-workflow research`
  prints a path under that worktree. The worktree's `git status --porcelain`
  stays empty. Dex state is still read from the main checkout.
- Doctor run from that worktree reports both staging checks PASS with paths
  under the worktree.
- With `.dex` a symlink to a folder outside the repository, doctor reports both
  staging checks FAIL.
- The existing staging and doctor tests still pass.
- The full suite passes, then `/dex:verify` and `/dex:review` run again.

Out of scope: review findings L1 (doctor outside git) and L3 (guard test).

## Backout / Reversibility

Every checkpoint is a plain revert. The staged files are disposable. Deleting
`.dex/_workflows/` has no effect on any feature.

## Risk Checkpoints

- **S1 live launch returns a path error.** Stop. The design's core assumption is
  wrong. Return to design. Do not quietly switch to the inline-text method.
- **The Dex guard refuses the `stage-workflow` command** (it guards writes to the
  state folder). Stop and return to design. Do not weaken the guard to make room
  for it.

## Least-Confident Structural Decisions

1. **Doctor writes the staged files.** It performs a real copy as its check. That
   is a stronger proof than a writability test, but it means a diagnostic command
   writes to disk. The files are Dex's own and disposable.
2. **The S1 live check uses a nonexistent feature name** to keep it cheap. It proves
   the tool accepts the path and the script loads. It does not prove a full
   research run from the copy. That only happens in the sample-project live check.
3. **Review gets no live check before merge.** It relies on S1 proving the path
   shape plus the human's sample-project check.
