---
name: status
description: Show the Dex lifecycle state for a feature — which gates are satisfied, which approvals are stale, and the next legal action. Use when asked about Dex progress or what to do next in a Dex feature.
argument-hint: [feature-slug]
allowed-tools: Bash, Read
---

# /dex:status

Report the feature's gate state.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" <slug>
```

With no slug it uses the active feature, or lists features when several are open.

Print the output verbatim. It is already terse and operational; do not summarize
it, reformat it, or soften it.

When the board shows all checkpoints complete, verification PASS, AI review PASS,
and human code review REQUIRED, the script appends a reading guide with the exact
diff commands and the file buckets that hide expensive mistakes. That is the point
of the whole workflow — do not truncate it.

Add `--review` to get that reading guide at any time.

## Do not

- Do not restate a gate as satisfied when the script says it is not.
- Do not offer to work around a blocked gate.
