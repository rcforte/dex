# Design: Workflow launch from plugin

> Answers one question: WHERE ARE WE GOING?
> Requires explicit human approval. Optimize for decision leverage, not length.

## Problem

`/dex:research` and `/dex:review` tell the Workflow tool to load their script from
the plugin folder. The Workflow tool only accepts script paths inside the current
project. The plugin folder is outside every project except this repository, so
both commands fail everywhere else.

## Current State

- Both skills launch with `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/<name>.js`
  and pass everything else through `args`.
  (`dex/skills/research/SKILL.md:26-40`, `dex/skills/review/SKILL.md:41-65`)
- The workflow scripts read nothing from their environment except `args`. A test
  enforces that they never mention `CLAUDE_PLUGIN_ROOT`.
  (`dex/tests/workflows-run.test.mjs:40-42`)
- A second test locks in the broken launch wording ("finding 22").
  (`dex/tests/workflows-run.test.mjs:44-53`)
- The live test in the sample project hit this bug. It was worked around by
  pasting the script text inline. (`dex/tests/LIVE-CHECKS.md:66,71`)
- `/dex:doctor` checks that each workflow file exists, has a name and description,
  and parses. It reads the file with Node, so it cannot see this failure.
  (`dex/scripts/doctor.mjs:74-93`)
- The state folder (`stateRoot`, default `.dex`) is always inside the repository.
  Config loading rejects any other value. (`dex/scripts/lib.mjs:393-398`)
  Dex keeps it out of `git status` through `.git/info/exclude`.
  (`dex/scripts/lib.mjs:820-836`)
- Feature scanning skips any folder in the state folder that has no `state.json`.
  (`dex/scripts/lib.mjs:735-738`)
- Feature names must start with a lowercase letter or digit.
  (`dex/scripts/lib.mjs:229-231`)

## Desired End State

In any project with Dex installed, both commands launch their workflow with no
path error. The workflows behave exactly as they do now. The plugin file stays the
only source of each workflow.

## Relevant Existing Patterns

### Pattern 1: Skills run plugin scripts through Bash

Evidence:
- Every skill runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" …`. Bash is not
  limited to project paths.

Applicability to this change: the copy step uses this same route. No new kind of
tool call is introduced.

### Pattern 2: Paths reach workflows through `args`

Evidence:
- `dex/workflows/research.js:22-42`, `dex/NOTES.md:9-11`

Applicability to this change: unchanged. Only the path to the script itself moves.

## Proposed Design

Before launching, the skill runs a new Dex command. The command copies the named
workflow from the plugin into the project's state folder and prints the copy's
absolute path. The skill passes that path as `scriptPath`.

- The copy lives at `<session checkout>/<stateRoot>/_workflows/<name>.js`. The
  "session checkout" is the top folder of the git checkout the command runs in
  (`git rev-parse --show-toplevel`). Usually that is the main checkout. In a
  session opened inside a linked worktree, it is that worktree. Outside git, it
  is the Dex root, as before. The leading underscore means it can never clash with
  a feature folder, because feature names cannot start with `_`.
- Dex state still lives only in the main checkout. Only the copy follows the
  session.
- The command overwrites the copy every time. A copy that is older than the plugin
  can never be launched.
- The command only accepts the known workflow names (`research`, `review`).
- It works the same inside this repository.

## End-to-End Flow

```text
user types /dex:research <slug>
  -> skill checks the questions gate (unchanged)
  -> skill runs: node <plugin>/scripts/state.mjs stage-workflow research
       -> copies <plugin>/workflows/research.js to <session checkout>/.dex/_workflows/research.js
       -> prints the absolute path
  -> skill calls Workflow with scriptPath = printed path, args unchanged
  -> workflow runs as today
```

`/dex:review` follows the same flow with `review`.

## Interfaces / Contracts

- New state script command: `stage-workflow <research|review>`. Prints the
  absolute path of the copy on success. Exits non-zero with a plain message on an
  unknown name or a write failure. It needs no feature and no gate.
- Skill text: `scriptPath` becomes "the path `stage-workflow` printed". `args`
  are unchanged.

## Data Changes

One new folder, `<stateRoot>/_workflows/`, holding up to two files. In a worktree
session it appears in that worktree. The existing state-folder rule lives in the
shared `info/exclude`, so it hides the folder in every worktree. It is also left
out of the code approval tree. Nothing to migrate.

## Security / Authorization

The Dex guard blocks Claude's direct writes to the state folder. The copy is made
by Dex's own script run through Bash, like every other state write, so the guard
rules do not change. The copy contains no approvals or gate state.

## Failure Semantics

- Copy fails: the command prints why and exits non-zero. The skill stops and
  reports it. It does not fall back to another launch method.
- The Workflow tool still refuses the path: the skill stops and reports the
  tool's message. The skills gain one line for this case, since neither "tool
  unavailable" nor `ok: false` covers it today.

## Compatibility

No change for existing features, state, or artifacts. Inside this repository the
launch path changes from the plugin file to the copy. Both work there.

## Observability

`/dex:doctor` adds one check per workflow. It makes the copy, then resolves the
real paths of both the copy and the session checkout, following symlinks. It
passes only when the copy is really inside that checkout. So a symlinked `.dex`
that points outside, or a copy that lands in another checkout, fails the check.

## Resolved Decisions

| Decision | Resolution | Reason |
| -------- | ---------- | ------ |
| How to launch from a user's project | Copy the script into the state folder, then launch by path | It uses exact bytes, costs little context, and the folder is already Dex's and hidden from git. Chosen by the human. |
| Where the copy lives | `<stateRoot>/_workflows/` under the session's own checkout | The Workflow tool judges "inside the project" by the session's folder. From a worktree session, the main checkout is outside it (AI review M1). The underscore cannot clash with a feature name. |
| What doctor compares | Real paths (symlinks resolved) of the copy and the session checkout | Comparing unresolved paths only repeated the config rule and could never fail (AI review M2). |
| When to copy | On every launch, overwriting | This keeps the plugin file the single source. A stale copy cannot run. |
| The report template path handed to the research report agent | Leave it as is | It worked in the sample project, and the agent has a built-in fallback. Chosen by the human. |
| The test that locks in the old wording | Rewrite it to require the staging step and forbid the plugin-folder `scriptPath` | Otherwise the old bug is protected by a test. |

## Open Questions

- None blocking. The live check in the sample project remains the only real proof
  that the Workflow tool accepts the staged path.

## Alternatives Considered

### Alternative A: Pass the script text inline

Advantages: writes no file into the project. Proven once by hand.

Risks: each launch reads about 18 KB and retypes it exactly. That is roughly 5,000
tokens each way, and one wrong character breaks or silently changes the workflow.

Reason rejected: the retyping risk. Chosen against by the human.

### Alternative B: Install as a named workflow in `.claude/workflows/`

Advantages: it would launch by name.

Risks: it writes into the user's Claude Code config folder. That folder is often
committed, and Dex does not own it.

Reason rejected: it is more invasive than the state folder, for no gain.

### Alternative C: Copy the templates too

Reason rejected: there is no evidence it is needed (see Resolved Decisions).

## Non-Goals

- Changing what either workflow does once started.
- Fixing the research "answered" count that ignores empty worker results. That is
  a separate bug, found during this feature's research.
- Changing the template path given to the research report agent.
- Changing the Workflow tool or plugin packaging.

## Least-Confident Decisions

1. **The doctor check.** It confirms the copy's real path lands inside the
   session checkout. It does not ask the real Workflow tool, which Node cannot
   reach. Whether the tool itself resolves symlinks is unconfirmed. Resolving
   them in doctor is the stricter choice.
   *Revised after drift:* a copy in the session's worktree means one extra hidden
   folder per worktree. It is kept out of git and the approval tree by the
   existing rules.
2. **Putting the copy in the state folder.** It is hidden from git and owned by
   Dex. But the Workflow tool's exact rules are only known from one live
   observation. A hidden folder is the least-tested kind of project path.
3. **No fallback when the launch is refused.** The skill stops rather than retrying
   inline. That is honest and simple, but it leaves the user stuck until they fix
   their setup.

These are the decisions the human reviewer should challenge first.
