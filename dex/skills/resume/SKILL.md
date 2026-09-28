---
name: resume
description: Resume a Dex feature in a fresh context, loading only the artifacts the next phase requires. Invoke with /dex:resume <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Glob, Grep
---

# /dex:resume

Rebuild just enough context to continue.

Long conversations degrade. Dex persists decisions into artifacts precisely so a
fresh session can pick up without replaying anything. Loading every artifact
would undo that — so load only what the next phase needs.

## 1. Read state

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" active <slug>
```

## 2. Load selectively by next phase

| Next phase | Read |
| ---------- | ---- |
| questions | `01-intent.md` |
| research | `02-questions.md` |
| design | `01-intent.md`, `03-research.md` |
| structure | `04-design.md` |
| plan | `04-design.md`, `05-structure.md` |
| worktree | state only |
| implement `Sn` | `04-design.md`, `05-structure.md`, the `Sn` section of `06-plan.md`, and the summary lines of `07-implementation-log.md` |
| verify | `06-plan.md` verification commands, `07-implementation-log.md` |
| review | `01-intent.md`, `04-design.md`, `05-structure.md`, verification summary, current diff |
| human code review | current diff, `04-design.md` |
| pr | all artifact paths, verification and review summaries |

Do not read the whole plan to implement one checkpoint. Do not read the research
report during implementation unless something specific requires it.

## 3. Report

```text
Resumed <slug>.
Current phase: <phase>
Loaded: <the artifacts you actually read>

<stale approvals or blocked status, prominently, if any>

Next legal action:
<command from the state machine>
```

If an approval is stale or the feature is blocked, lead with that. Do not continue
forward past it.
