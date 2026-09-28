---
name: start
description: Begin a Dex feature — capture intent as 01-intent.md and initialize the state machine. Invoke with /dex:start <feature description>.
disable-model-invocation: true
argument-hint: <feature description>
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /dex:start

Capture what problem we are solving. Nothing else.

Do not research. Do not design. Do not write code. Do not propose an approach.

## 1. Check that Dex is the right tool

Dex is a heavy harness. It earns its cost on: multi-file features, new endpoints,
schema changes, new screens, cross-layer behavior, architectural change,
significant refactors, and complex production bugs that need investigation.

It is the wrong tool for a typo, a rename, a copy change, a small config edit, an
obvious one-line fix, or a throwaway prototype. If the request is one of those,
say so in one sentence and offer to just make the change. Do not start a feature
the user did not ask to start.

## 2. Derive a title and slug

From the user's description, write a concise title — a noun phrase of two to four
words naming the capability ("Portfolio optimization", "Bulk invoice export").

The slug is the title, lowercased and hyphenated. Keep it short: it becomes a
directory name and a branch name.

## 3. Initialize state

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" init <slug> --title "<title>"
```

This creates `.dex/<slug>/state.json`, `.dex/config.json` if absent, the artifact
directory, and marks the feature active. It refuses to overwrite an existing
feature — if it reports one exists, stop and tell the user to run `/dex:resume`.

## 4. Write 01-intent.md

Start from `${CLAUDE_PLUGIN_ROOT}/templates/intent.md`. Write it to the path the
init command printed.

Fill it from what the user actually said, plus a brief look at the repository to
get names and conventions right (`README`, `CLAUDE.md`, top-level layout). Do not
go exploring — that is the research stage's job.

Rules for this document:

- Describe the **problem**, not the solution. If you catch yourself naming a class
  or a table that does not exist yet, delete it.
- **Non-Goals** and **Unknowns** are the two sections that pay for themselves.
  Unknowns are things that must not be silently decided later. Be generous here.
- **Acceptance Signals** must be observable: a response shape, a persisted record,
  an emitted event, a visible state. Not "works correctly".
- Where you genuinely do not know something, write `Unknown — needs research` or
  `Not applicable`. Do not invent content to fill a heading.

Ask the user directly about anything material you cannot determine — scope
boundaries and constraints especially. One or two questions, not an interrogation.

## 5. Stop

Print:

```text
Created:
docs/dex/<slug>/01-intent.md

Read it. Intent is the one artifact nobody else can write for you.

Next:
/dex:questions <slug>
```

Do not continue to the next stage.
