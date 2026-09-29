# Feature Intent: Commit before worktree

> Written before any research. Describe the problem, not the solution.
> If a section does not apply, write "Not applicable" rather than inventing content.

## Problem

Dex can trap a user between two of its own rules.

- `/dex:worktree` refuses to create the feature worktree while the main checkout
  has uncommitted changes (outside the artifact folder). It tells the user to
  deal with them first.
- The Dex guard refuses `git commit` from Claude while the active feature has no
  worktree yet. It says implementation has not been unlocked.

So a user with unrelated uncommitted work cannot ask Claude to commit it. The only
way out is to run `git commit` themselves outside Claude's tool calls.

Seen on 2026-09-28 during the `workflow-launch` feature. A modified
`dex/tests/LIVE-CHECKS.md` blocked `/dex:worktree`. Claude's commit was then
refused with "Dex blocked git commit for feature "workflow-launch" because
implementation has not been unlocked." The user had to type
`! git commit ...` by hand.

## Desired Outcome

A user who reaches `/dex:worktree` with uncommitted changes in the main checkout
has a path forward from inside the Claude session. They are not told to do
something Dex will then refuse.

## User / Actor

A developer running a Dex feature in Claude Code, with unrelated work in progress
on their main branch when they reach the worktree stage.

## Scope

- The conflict between `/dex:worktree`'s clean-tree requirement and the guard's
  refusal of commits before a worktree exists.
- The messages both of them show, so they point at an action that works.

## Non-Goals

- Letting Claude commit production code on the main branch during a feature. The
  guard exists to stop that.
- Changing what counts as "implementation unlocked" for code edits.
- Stashing, resetting, or discarding the user's changes automatically.
  `/dex:worktree` forbids this, and that stays.
- Other guard refusals, such as push or approval.

## Constraints

- The guard's purpose must survive. Before the gates allow implementation, Claude
  must not be able to land feature code anywhere.
- The user's uncommitted work is theirs. Dex must never discard or hide it.
- Any exception must be something a user can understand from the refusal message.

## Acceptance Signals

- With uncommitted changes in the main checkout and a feature in the worktree
  phase, following `/dex:worktree`'s instructions leads to a created worktree.
  No step is refused by Dex, and nothing has to be typed outside Claude.
- A commit that Dex still refuses gets a message naming a way forward that
  actually works.
- The existing guard tests still pass. Commits of production code before
  implementation is unlocked are still refused.

## Unknowns

- Whether `/dex:worktree` needs a clean main checkout at all. `git worktree add`
  works with uncommitted changes, and the skill says so itself. Why does the
  skill stop? Needs research.
- Which commits the guard should allow before a worktree exists, if any: only
  files unrelated to the feature, only when the user asked, or none. This is a
  policy decision for the human.
- How the guard tells a commit from other git commands, and where the
  "implementation has not been unlocked" rule is decided. Needs research.
- Whether the same trap exists at other stages, for example before the feature's
  questions are approved. Needs research.
- Whether the user typing `! git commit` should stay the intended answer, with
  only the messages changed. This must be decided by the human, not silently.
