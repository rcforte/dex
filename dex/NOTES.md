# Notes

Facts about Claude Code that Dex depends on, checked in a live session.

## Checked 2026-09-28

The check used a throwaway `probe` plugin, loaded with `claude --plugin-dir` and run in auto mode.

**`${CLAUDE_PLUGIN_ROOT}` is filled in inside a skill's own text.**
- A skill body containing `${CLAUDE_PLUGIN_ROOT}` reached the model as the real plugin path.
- So skills can pass script and template paths to workflows through `args`. No `SessionStart` fallback is needed.

**The `UserPromptSubmit` hook receives the raw text you typed.**
- The text arrives in the `prompt` field. For example, typing `/probe:approve design foo` gives `"prompt": " /probe:approve design foo"`, not the skill's expanded body.
- The text can start with a space, so matching must allow leading whitespace.
- The hook's environment has `CLAUDE_PLUGIN_ROOT` set.
- Other fields in the payload: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name`.

**The model cannot run a user-only skill, and cannot trigger this hook.**
- Asked to run a skill marked `disable-model-invocation: true`, the Skill tool refused with "cannot be used with Skill tool due to disable-model-invocation".
- The only hook entry was the user's own sentence. No `/probe:approve` entry appeared.

**What this means for the plan.** Step 2 can record approvals from the `UserPromptSubmit` hook as planned.
