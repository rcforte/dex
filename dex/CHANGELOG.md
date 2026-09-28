# Changelog

All notable changes to the Dex plugin.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-27

Initial release.

### Lifecycle

Replaces the monolithic research → plan → implement pattern with staged commands,
each with one purpose and one primary artifact:

```text
Intent → Questions → Research → Design → Structure → Plan → Worktree
      → Implement → Verify → AI Review → Human Code Review → PR
```

### Added

- **16 stage skills** — `start`, `questions`, `research`, `design`, `structure`,
  `plan`, `worktree`, `implement`, `verify`, `review`, `approve`, `status`,
  `next`, `resume`, `pr`, `doctor`. Lifecycle stages are human-invoked
  (`disable-model-invocation: true`); the read-only helpers are not.

- **Deterministic state machine** (`scripts/state.mjs`) — owns every gate
  decision. Skills call it rather than reimplementing gates in prose. Atomic
  writes (temp file, fsync, rename) and a per-feature lock with stale-lock
  recovery.

- **Approval integrity** — each human approval is bound to the SHA-256 of the
  artifact approved. Editing an approved artifact makes its approval stale, and
  downstream stages refuse to proceed until it is re-approved.

- **Diff-bound human code approval** — `/dex:approve code` fingerprints the
  production diff, including untracked new files, excluding Dex's own documents.
  Any later production change voids the approval and blocks the PR.

- **PreToolUse guard** (`scripts/guard.mjs`) — refuses production code
  modification before the implementation gates pass, and refuses push and
  pull-request creation before human code approval is current. Conservative shell
  inspection covering git mutations, destructive file operations, in-place
  editors, dependency installs, database migrations, and redirects into source.
  Read-only inspection and test and build commands are never refused. Gating is
  inert when no Dex feature is active.

- **Research context isolation** (`workflows/research.js`) — parses approved
  questions, fans out one probe per question, verifies findings adversarially,
  and synthesizes a report. Workers never receive the feature intent, so they
  report how the system works rather than where the feature should go.

- **Multi-angle AI review** (`workflows/review.js`) — scopes the diff, reviews
  chosen dimensions in isolated contexts, then consolidates: deduplicates, checks
  evidence, drops style trivia, re-ranks by severity. Records no approval.

- **Four functional subagents** — `research-probe`, `research-verifier`,
  `implementation-reviewer`, `verification-analyzer`. Named for what they do, not
  for job titles. The research agents have no write tools.

- **Nine artifact templates** in `templates/`, including the correct distinction
  between a vertical slice (the shape of a change) and a tracer bullet (the
  purpose and depth of an early slice).

- **Design drift protocol** — when repository evidence invalidates an approved
  artifact, implementation stops and the feature blocks until a human revises and
  re-approves it.

- **Configuration** — `.dex/config.json`, created once and never overwritten.
  Unknown fields warn and never change behavior, so a typo cannot silently
  disable a gate.

- **Event log** — append-only `events.jsonl` per feature, recording decisions and
  hashes. Prompts, secrets, and environment contents are redacted.

- **`/dex:resume`** — rebuilds only the context the next phase requires, so work
  survives a restarted session without replaying the conversation.

- **123 tests** across state, guard, and plugin structure, using Node's built-in
  test runner. Each builds a throwaway git repository; none touches the real
  working tree.

### Requirements

Node.js 18 or later and git. No npm dependencies — Node built-ins only, so the
plugin works without an install step.
