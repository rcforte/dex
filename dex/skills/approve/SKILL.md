---
name: approve
description: Record a human approval gate — questions, design, structure, or code. Invoke with /dex:approve <gate> <feature-slug>.
disable-model-invocation: true
argument-hint: <questions|design|structure|code> <feature-slug>
allowed-tools: Bash, Read
---

# /dex:approve

Record that a human approved something.

This skill does not decide whether the thing is good. The human did that. Your
only job is to invoke the state script so the approval is bound cryptographically
to what was actually approved.

## Run the script

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" approve <gate> <slug>
```

Gates: `questions`, `design`, `structure`, `code`.
`code` records the human code review and binds to a diff fingerprint.

Print the script's output verbatim. It contains the artifact path and the hash,
which is the record of what was approved.

## Never do this

- Do not update state by writing JSON yourself. The script computes hashes,
  checks upstream gates, appends the event log, and takes the feature lock. Hand
  edits produce an approval that means nothing.
- Do not approve on the user's behalf because the artifact looks fine to you.
  If the user asks you to "approve it", they have made the decision — run the
  command. But do not volunteer an approval they did not ask for.
- Do not work around a refusal. If the script refuses, it is because a gate is
  unsatisfied; relay the message and the recovery command.

## Before `/dex:approve code`

This is the gate the whole harness exists to protect. Before running it, confirm
the user has actually read the diff. If it is not clear they have, show them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" <slug> --review
```

and ask. Then run the approval if they confirm.

If they say they have read it, take them at their word and run the command. Do not
lecture.

## After a stale approval

When an approved artifact changes, its approval goes stale — that is the design
working, not a bug. Say what changed, then re-run the same approval command.
