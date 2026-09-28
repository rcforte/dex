---
name: implement
description: Implement one approved checkpoint in the isolated worktree, verify it, and record the result in 07-implementation-log.md. Invoke with /dex:implement <feature-slug> [checkpoint].
disable-model-invocation: true
argument-hint: <feature-slug> [checkpoint-id]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task
---

# /dex:implement

Implement **one** checkpoint. Then stop.

## 1. Check gates and pick the checkpoint

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Proceed only when `gates.canImplement.allowed` is true. When it is false, print
the blockers verbatim and stop — the PreToolUse guard will refuse the edits
anyway, and hitting that wall wastes a turn.

With no checkpoint given, use `gates.implementation.next`. One checkpoint per
invocation: that is what gives the human a place to re-steer.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" start-slice <slug> <id>
```

## 2. Load only what this checkpoint needs

Read: `04-design.md`, `05-structure.md`, this checkpoint's section of
`06-plan.md`, the project's `CLAUDE.md` or equivalent rules, and the current code
you are about to change.

Do not load the whole plan, the whole research report, or previous conversation.
Earlier checkpoints are summarized in `07-implementation-log.md` if you need them.

## 3. Read the current code before editing it

Mandatory. Open every file you are about to change and read the relevant code.

Plans go stale. Code is ground truth. The authority order is:

```text
Repository reality  >  approved design intent  >  approved structure  >  tactical plan  >  what you remember
```

## 4. Implement the smallest coherent change

Work in the recorded worktree path. Do not `cd` into it: use absolute paths
for files and `git -C <worktree>` for git, so it is always clear which checkout
a command touches.

Write code that reads like the surrounding code — its naming, its idiom, its
comment density, its error handling conventions.

### Scope discipline

Do not, while you are in there:

- rewrite unrelated code
- rename unrelated components
- upgrade libraries
- fix unrelated style or lint problems
- change architecture outside the approved scope

If something outside scope genuinely must change for this checkpoint to work, say
so and get agreement first. Unrequested changes are the hardest thing for a human
reviewer to trust, because they have no approved design behind them.

## 5. Verify, then inspect the diff

Run this checkpoint's verification commands from the plan.

Then read your own diff:

```bash
git diff
git status --porcelain
```

Look for debug statements, commented-out code, accidental file additions, and
changes you did not intend.

If verification fails, repair it. If the output is long or confusing, delegate to
the `verification-analyzer` subagent to separate the root cause from the cascade.
Never make a test pass by deleting or skipping it.

## 6. If the repository contradicts the approved design — STOP

Do not make it work anyway.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" drift <slug> --target <design|structure> --reason "<what the code shows vs what the design assumed>" --slice <id>
```

`--target design` when the destination changed; `--target structure` when only
the route changed.

Record the full picture in the `DESIGN DRIFT` section of
`07-implementation-log.md`: the checkpoint, the discovery, the evidence with file
and line numbers, the impact, and whether design or structure needs revising.

This blocks the feature until the affected artifact is revised and the user
approves it again with `/dex:approve`. Dex then unblocks the feature by itself.
That is correct. Silently improvising a materially different architecture is how a
feature ends up as something nobody approved.

## 7. Record the result

Append to `07-implementation-log.md` using
`${CLAUDE_PLUGIN_ROOT}/templates/implementation-log.md`: status, changes, files,
verification command and result, divergence from plan, new discoveries, follow-up
risk. Keep it short — this is the compaction artifact a fresh context reads.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" finish-slice <slug> <id> --verification "<command that proved it>" --note "<one line>"
```

The script refuses to mark a checkpoint complete without a verification result.

## 8. Stop

Report what changed, what verified it, and the next checkpoint.

Do not start the next checkpoint unless the user explicitly asks. The pause is the
point — it is where a human notices the implementation has gone somewhere they did
not intend, while it is still cheap to change.

If `reviewCadence` is `slice`, or `checkpoint` and this was the tracer, say
explicitly that a human should read this diff before the next checkpoint starts.
