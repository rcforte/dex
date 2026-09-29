# Research Questions: Commit before worktree

## Objective

Establish the minimum factual understanding of the existing system needed
before designing the change.

## Questions

### System flow

1. How does `dex/scripts/guard.mjs` decide whether a Bash command is allowed? Trace
   a `git commit` command from the PreToolUse hook input to the final allow or deny
   decision. Name the functions, files, and lines involved.
2. How do `dex/scripts/shell.mjs` and `dex/scripts/commands.mjs` classify git
   commands, for example `commit`, `add`, `stash`, `worktree add`, `merge`,
   `push`? Which are treated as changes, which as publishing, and which as
   read-only?

### Domain ownership

3. In `dex/scripts/guard.mjs` and `dex/scripts/state.mjs`, what conditions make a
   change "allowed" in each feature phase? Where does the refusal text "has not
   been unlocked" come from? List every phase in which a `git commit` in the main
   checkout is refused.
4. Does the guard treat a command differently depending on which checkout it runs
   in: the main checkout, a feature worktree, or a path given with `git -C`? How
   does it tell them apart?

### Conventions

5. What exactly does `dex/skills/worktree/SKILL.md` tell the model to do when the
   main checkout has uncommitted changes? What reason does it give? Does anything
   in `dex/scripts/` (for example `record-worktree`) also refuse on uncommitted
   changes?

### Existing analogous behavior

6. Does the guard already allow any change-type command in a phase where
   implementation is not unlocked? For example writes to `docs/dex/**` or
   `.dex/**`, or specific state.mjs commands. How is each such exception
   expressed in code and tested?
7. Where in the skills or the README does Dex tell the user to run a command
   themselves, such as `! <command>` or "in your own terminal"? What wording and
   situations are used?

### Tests

8. Which tests in `dex/tests/guard.test.mjs` and `dex/tests/shell-guard.test.mjs`
   cover `git commit`? Which phases and checkouts do they exercise, and what do they
   expect?

### Error handling

9. What does each guard refusal message tell the user to do next? Does any refusal
   in `dex/scripts/guard.mjs` point to a command or skill that would itself refuse
   in the same state?

## Explicitly excluded from research

Research must not propose the implementation.

Research must not decide the architecture.

Research must not infer the desired solution from the ticket.

Research workers never see the feature intent. They see one question each.

## Human Notes

Add, remove, or rewrite questions here before approval. Deleting a question is
as valuable as adding one: every question costs a research worker.
