# Changelog

All notable changes to the Dex plugin.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-28

Fixes from an adversarial review. The finding numbers refer to
`review-findings.md` in the repository that holds this plugin.

### Changed

- **Only the user approves.** Approvals are recorded by a new
  `UserPromptSubmit` hook when the user types `/dex:approve <gate> <slug>`. The
  guard refuses the approve command from tool calls and refuses writes to `.dex/`
  (findings 1, 2). `approve` takes `<gate> <slug>` only (finding 29).
- **The code approval is a git tree**, built from the feature checkout minus the
  feature's own documents. Staging and committing keep it valid; any real change
  voids it. Publishing also requires HEAD to hold exactly that tree. The base
  commit is pinned when implementation starts (findings 4, 5, 6).
- **Gates re-check everything upstream.** Implementation needs current questions;
  publishing needs everything implementation needs. Verification and AI review
  apply only to the code they checked. Re-approving the questions makes the
  design stale, and the design the structure (findings 8, 11, 12).
- **Drift** takes `--target design|structure` and is cleared automatically once
  the revised documents are approved again (finding 20).
- **Research** covers every approved question, including Human Notes;
  `maxResearchWorkers` limits concurrency. Probes run as the read-only
  `research-probe` agent (findings 17, 18).
- **`/dex:pr`** commits the feature documents with the code (Q11).

### Added

- `scripts/shell.mjs` and `scripts/commands.mjs`: the guard parses shell
  commands instead of pattern-matching them (findings 13, 14, 26, 27, 41).
- `scripts/pre-push.mjs` and `state.mjs install-hook`: a git pre-push hook that
  gates `dex/*` pushes however they are started. `/dex:worktree` installs it.
- `state.mjs diff-hash --json`, and warnings from `set-slices` when checkpoints
  do not match the structure document (finding 37).
- Tests that run the hooks as real processes, run the workflows with a fake
  agent, and drive the whole flow end to end.

### Fixed

- Dex finds its state from inside a worktree (finding 3), and `.dex/` no longer
  makes the tree look dirty (finding 10).
- Unreadable state, a broken active marker, several active features with none
  selected, or a guard crash now refuse changes instead of allowing everything
  (findings 7, 19).
- The hook matcher covers ApplyPatch, PowerShell and MCP write tools; the hooks
  work through symlinked plugin folders (findings 15, 16).
- Workflows receive the plugin's paths as arguments (finding 9); skills use
  `scriptPath`, exact review dimension names, and stop on a failed workflow
  (finding 22).
- `requireWorktree` is read live; `record-worktree` accepts only a real linked
  worktree (finding 23).
- Checkpoints: no finishing without starting, no silent dropping, `S01` equals
  `S1` (finding 21). Flags given without a value are errors.
- Secrets are scrubbed before truncation and before anything is stored (finding
  24). Slugs are validated before any folder is created (findings 25, 33, 34).
- Locks survive half-written files and clock skew; `init` checks under the lock
  (finding 28). Doctor no longer writes into the repository (findings 31, 32).

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
