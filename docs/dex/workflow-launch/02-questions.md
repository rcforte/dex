# Research Questions: Workflow launch from plugin

## Objective

Establish the minimum factual understanding of the existing system needed
before designing the change.

## Questions

### System flow

1. In `dex/skills/research/SKILL.md` and `dex/skills/review/SKILL.md`, what are the
   exact steps that lead up to starting a workflow? What inputs are passed to the
   Workflow tool, and what happens after it returns?
2. What do `dex/workflows/research.js` and `dex/workflows/review.js` read from their
   environment when they run: arguments, file paths, `args`, environment variables,
   or anything relative to the plugin folder or the working directory? Give the size
   of each file.

### Domain ownership

3. Which files in `dex/` refer to `CLAUDE_PLUGIN_ROOT` (or to the plugin folder by
   any other means), and what does each reference do?

### Configuration

4. How does the plugin declare its skills, agents, hooks, and workflows to Claude
   Code? Is there a plugin manifest, and does it list workflows?

### Data and persistence

5. Which directories inside a user's project does Dex currently write to (for
   example state, artifacts, config)? How is each location chosen, and which are
   covered by `.gitignore` handling or other hygiene code?

### Observability

6. What does `/dex:doctor` (`dex/skills/doctor/SKILL.md` and `dex/scripts/doctor.mjs`)
   check about workflows today? How does it decide a workflow check passed?

### Tests

7. What do `dex/tests/workflow.test.mjs` and `dex/tests/workflows-run.test.mjs`
   test? Do any tests run Dex from a project directory that is outside the plugin
   folder?
8. What does `dex/tests/LIVE-CHECKS.md` record about launching workflows, and about
   running Dex in a project other than this repository?

### Existing analogous behavior

9. Do any other Dex skills or scripts hand a plugin file to a Claude Code tool that
   might restrict paths (for example Read, Write, Bash, or Agent)? How do they refer
   to that file?
10. Does anything in the repository (`dex/NOTES.md`, `dex/CHANGELOG.md`,
    `readme.md`, `implementation-plan.md`, `review-findings.md`) record known
    limits of the Workflow tool, such as which paths it accepts, running a workflow
    by name, or passing a script inline?

## Explicitly excluded from research

Research must not propose the implementation.

Research must not decide the architecture.

Research must not infer the desired solution from the ticket.

Research workers never see the feature intent. They see one question each.

## Human Notes

Add, remove, or rewrite questions here before approval. Deleting a question is
as valuable as adding one: every question costs a research worker.

The Workflow tool's real path rules are not in this repository. Research can only
report what the repo records about them (question 10). The rest must be checked by
hand before design.
