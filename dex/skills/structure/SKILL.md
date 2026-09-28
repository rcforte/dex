---
name: structure
description: Convert an approved design into a program structure with vertical implementation checkpoints, producing 05-structure.md. Invoke with /dex:structure <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /dex:structure

Answer one question: **how do we get there in safe, observable steps?**

The design said where we are going. This says what the program looks like and in
what order it becomes real.

## 1. Check the prerequisite

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Proceed only when `gates.design.status` is `APPROVED`. If it is `STALE`, the
design changed after approval — stop and ask for re-approval.

Read `04-design.md`. Read the actual files you are about to describe changing;
their real shape constrains the structure.

## 2. Write the structure

Use `${CLAUDE_PLUGIN_ROOT}/templates/structure.md`.

Think header files, not code: types, fields, signatures, endpoints, message
schemas, file locations, call flow, execution order, verification points.

**No implementation bodies.** If you are writing logic, you have gone too far —
that belongs in the code, and describing it twice guarantees the two disagree.

Be concrete about the change surface: which existing files are modified, which are
new, which are deleted.

## 3. Design the verification before the implementation

For every checkpoint, answer: **what proves this works?**

Concrete answers: a named unit test, an integration test, a curl request with an
expected response, a Playwright scenario, a contract test, an event assertion, a
database assertion, a compile, the existing regression suite.

"Ensure everything works" is not a verification. Neither is "test the feature".

## 4. Build vertical checkpoints

Each checkpoint should cut through the layers it needs and produce an observable
result:

```text
Checkpoint 1   entry point -> application -> domain -> persistence -> observable result -> verification
Checkpoint 2   deepen the same path with real business behavior
Checkpoint 3   add the next capability or edge case
```

### Check your own work for horizontal sequencing

Before finishing, read your checkpoint list back. If it looks like this:

```text
Phase 1  database schema
Phase 2  repositories
Phase 3  services
Phase 4  API
Phase 5  frontend
Phase 6  tests
```

stop and restructure it vertically. Horizontal sequencing means nothing is
observable until the end, which is precisely when a wrong assumption has become
expensive. Tests are never their own phase.

Only if the work genuinely cannot be verticalized, keep the **Horizontal
dependency exception** section and fill in why, plus the earliest point at which
something executes. Deleting that section is the normal case.

## 5. Decide on a tracer bullet

State it explicitly: `Tracer bullet required: YES | NO` with a reason.

These are different ideas and conflating them produces bad plans:

- A **vertical slice** describes the *shape* of a change: end-to-end through the
  relevant layers.
- A **tracer bullet** describes the *purpose and depth* of an early slice: the
  thinnest end-to-end implementation needed to prove the architectural path works.

So: tracer bullet = thin vertical proof. Subsequent vertical slices =
production-quality deepening. Not every slice is a tracer.

Use one when real integration or architecture uncertainty exists — a new external
integration, a new persistence technology, a new event pipeline, a first touch of
an unfamiliar legacy subsystem, a cross-service feature.

Skip it for localized behavior changes, well-understood refactors, and simple
business rule extensions. A tracer bullet for work you already understand is
ceremony.

If YES, name exactly which uncertainty it resolves, and make checkpoint S1:

- go end-to-end
- deliberately minimize behavior
- prove the integration boundaries
- be testable or observable

It must not become a throwaway prototype disconnected from production code, and it
must not require every layer finished before anything runs. Later checkpoints
deepen the same architecture rather than replacing it.

## 6. Stop at the gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" transition <slug> structure-started
```

Print:

```text
Review the structural outline:
docs/dex/<slug>/05-structure.md

Check three things:
- are the checkpoints vertical and individually observable?
- is the tracer decision right?
- does each checkpoint's verification actually prove something?

When satisfied:
/dex:approve structure <slug>
```

Do not generate implementation code before that approval.
