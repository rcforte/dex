---
name: next
description: Print the single next legal Dex command for a feature, computed from the state machine. Use when asked what the next step is in a Dex feature.
argument-hint: [feature-slug]
allowed-tools: Bash
---

# /dex:next

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" next <slug>
```

Print the result verbatim.

The state machine computes this. Do not reason about the lifecycle yourself and
do not suggest a different command than the one it names — if it says the next
action is re-approving a stale artifact, that is the next action, even when
continuing forward looks more productive.
