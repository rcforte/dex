---
name: approve
description: Record a human approval gate — questions, design, structure, or code. Invoke with /dex:approve <gate> <feature-slug>.
disable-model-invocation: true
argument-hint: <questions|design|structure|code> <feature-slug>
allowed-tools: Bash, Read
---

# /dex:approve

The approval is already recorded, or refused, by the time you read this.

When the user typed `/dex:approve <gate> <slug>`, Dex's prompt hook recorded it
before this skill started. The hook added a message to your context. It starts
with "Dex recorded" or "Dex did not record".

You cannot record an approval yourself. Dex refuses the approve command from a
tool call, and refuses writes to its state folder.

## Report what happened

Check the gate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" status <slug>
```

Then tell the user, in one or two lines:

- **Recorded:** the gate is now APPROVED. Say what comes next.
- **Refused:** relay the reason from the hook message and its recovery command.
- **No hook message, and the gate is not APPROVED:** the hook did not run. Ask the
  user to run this in their own terminal:

  ```bash
  node <path-to-dex>/scripts/state.mjs approve <gate> <slug>
  ```

Gates: `questions`, `design`, `structure`, `code`.

## Never

- Never try to approve another way, for example by editing state files or
  calling the approve command through another program. That is exactly what the
  gate exists to stop.
- Never tell the user an approval was recorded unless `status` shows it.

## Before `/dex:approve code`

Typing the command is the user's confirmation that they read the diff. If they
ask how to review it first, point them to:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" <slug> --review
```

## After a stale approval

When an approved artifact changes, its approval goes stale. That is the design
working, not a bug. Say what changed, and tell the user to type the same
`/dex:approve` command again.
