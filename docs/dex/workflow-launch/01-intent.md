# Feature Intent: Workflow launch from plugin

> Written before any research. Describe the problem, not the solution.
> If a section does not apply, write "Not applicable" rather than inventing content.

## Problem

Two Dex commands cannot run anywhere except the Dex source repository.

`/dex:research` and `/dex:review` each start a multi-agent workflow. They tell the
Workflow tool to load the workflow script from the installed plugin's folder
(`${CLAUDE_PLUGIN_ROOT}/workflows/research.js` and `.../review.js`). The Workflow
tool refuses a script path that sits outside the current project. The plugin
folder is always outside the user's project, so both commands fail.

It only works in this repository by accident: here the plugin folder happens to be
inside the project.

Anyone who installs Dex and uses it on their own project is blocked at the
research stage. Since review comes later, they never reach it either.

## Desired Outcome

In any project where the Dex plugin is installed, `/dex:research <slug>` and
`/dex:review <slug>` start their workflows and run to completion, exactly as they do
in this repository today.

The workflows behave the same as now: same stages, same agents, same outputs.

## User / Actor

A developer who has installed the Dex plugin and runs Dex commands from Claude Code
inside their own project.

## Scope

- Getting the research workflow to start from any project.
- Getting the review workflow to start from any project.
- Any change to the two skills' instructions that this requires.
- Keeping `/dex:doctor` honest: if it checks workflows, it should catch this kind of
  failure rather than report healthy.

## Non-Goals

- Changing what the research or review workflows do once they start.
- Changing any other Dex command or stage.
- Changing the Workflow tool itself or asking for a new Claude Code feature.
- Redesigning how Dex is packaged or installed.

## Constraints

- The Workflow tool refuses script paths outside the project. Dex cannot change that.
- Dex must keep working inside this repository, where the plugin folder is inside
  the project.
- The user's project should not be left with stray or confusing files. Anything Dex
  writes into it must be clearly Dex's and must not break the user's git status or
  builds.
- One source of truth for each workflow script. Two copies that can drift apart
  would be a new bug.

## Acceptance Signals

- In a fresh project outside this repository, with Dex installed, `/dex:research`
  on a feature past the questions stage launches the workflow with no path error and
  writes the research artifact.
- In the same project, `/dex:review` launches its workflow with no path error and
  writes the review findings.
- The same two commands still work inside this repository.
- `/dex:doctor` run in a project where the workflows cannot launch reports a
  failure, not a pass.

## Unknowns

- Exactly which paths the Workflow tool accepts. Is it the working directory only,
  or also the scratchpad directory, `.claude/workflows/`, or somewhere else? Needs
  research.
- Whether the Workflow tool can run a workflow by name from a plugin, the way it can
  from `.claude/workflows/`. Needs research.
- Whether an inline script (passed as text, not a path) is an acceptable launch
  method, given the scripts' size and that the skill would have to read the file
  first. Needs research.
- If a copy of the script must live inside the user's project, where it goes, who
  cleans it up, and whether it gets committed. This must be decided by the user,
  not silently.
- Whether any other Dex command has the same kind of hidden dependence on the
  plugin folder being inside the project. Needs research.
- How to test this repeatably, since the bug does not show up inside this
  repository.
