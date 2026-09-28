---
name: plan
description: Generate the tactical implementation plan 06-plan.md from an approved structure, and record the implementation checkpoints in state. Invoke with /dex:plan <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /dex:plan

Write the instructions an implementation agent needs, in a fresh context, to
execute one checkpoint at a time.

This artifact is for the agent. Humans review intent, design, structure, and the
actual code. They can spot-check this.

## 1. Check the prerequisite

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Proceed only when `gates.structure.status` is `APPROVED`. If `STALE`, stop and ask
for re-approval.

Read `04-design.md` and `05-structure.md`. Open the files you are planning to
change and confirm the symbols you are about to reference actually exist.

## 2. Write the plan

Use `${CLAUDE_PLUGIN_ROOT}/templates/plan.md`. One section per checkpoint from the
approved structure, with the same ids (S1, S2, …).

For each checkpoint: objective, preconditions, files with the change and the
reason, relevant symbols, implementation steps, tests, verification commands,
expected observable result, and stop conditions.

Reference exact files and symbols:

```text
GOOD  Change PortfolioService.createPortfolio() to pass the optimization request
      through to OptimizationRunner, returning the run id.
      Relevant symbols: PortfolioService:88, OptimizationRunner.submit()

BAD   [a forty-line Java method body]
```

Writing the code in the plan produces a second implementation that disagrees with
the first. Describe the change; let the implementation read the code.

**Verification commands must be real commands for this repository.** Find them in
`CLAUDE.md`, `package.json` scripts, `pom.xml`, `build.gradle`, `Makefile`,
`justfile`, `Cargo.toml`, `pyproject.toml`, `go.mod`, or the CI config. Do not
guess a command that does not exist here.

**Stop conditions** are what makes the plan safe. For each checkpoint, name the
discoveries that mean the agent should stop and return to design or structure
rather than improvising.

## 3. Record the checkpoints in state

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" set-slices <slug> "S1:<name>" "S2:<name>" "S3:<name>"
```

Ids and names must match the plan. Include the word "tracer" in the name of a
tracer checkpoint so state records it as one.

## 4. Stop

Print:

```text
Tactical plan ready:
docs/dex/<slug>/06-plan.md

Recorded <n> checkpoints: S1, S2, S3

This artifact is primarily for the implementation agent. Spot-check it for obvious
divergence from the structure you approved — but plan review is not code review,
and it does not substitute for reading the diff later.

Next:
/dex:worktree <slug>
```

There is no human approval gate on the tactical plan by default.
