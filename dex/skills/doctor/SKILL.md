---
name: doctor
description: Check that Dex can run here — runtime, git, plugin components, hooks, workflows, and whether the state and artifact directories are writable. Use when Dex commands misbehave or after installing the plugin.
allowed-tools: Bash, Read
---

# /dex:doctor

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

Print the output verbatim. It exits non-zero when something is broken.

If a check fails, fix the specific thing it names. Common cases:

- **Node below 18** — the scripts use modern built-ins; upgrade Node.
- **Not a git repository** — the human code approval gate binds to a git tree and
  cannot function without git. Dex will still run the earlier stages.
- **State or artifact root not writable** — check directory permissions.
- **Hooks missing** — nothing is enforcing the gates. The plugin is incomplete;
  reinstall it.
- **Config warnings** — an unknown or wrongly typed field in `.dex/config.json`.
  Unknown fields never change behavior, so a typo silently does nothing. Fix the
  spelling.

Do not paper over a failure by suggesting the user skip the affected stage.
