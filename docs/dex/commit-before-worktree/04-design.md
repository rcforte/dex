# Design: Commit before worktree

> Answers one question: WHERE ARE WE GOING?
> Requires explicit human approval. Optimize for decision leverage, not length.

## Problem

`/dex:worktree` stops when the main checkout has uncommitted changes. The natural
answer is "commit them". But the guard refuses Claude's `git commit` in every
phase before implementation. The user is stuck unless they know to run the commit
themselves.

## Current State

- The worktree skill says "If there are uncommitted changes, **stop and ask**".
  It forbids stashing, resetting, or cleaning, and notes that "a worktree can be
  created without touching it". It does not say what to offer the user.
  (`dex/skills/worktree/SKILL.md` step 2)
- `git worktree add` works with uncommitted changes. The new worktree branches
  from the last commit, so those changes are not in it. That is the real risk
  behind the stop.
- The guard labels `git commit` a repository change with no paths. It judges the
  commit by phase alone, and refuses it before `implement` with "…because
  implementation has not been unlocked". The message's `Next:` line is
  `nextAction`. In the worktree phase that is `/dex:worktree`, which loops back.
  (`guard.mjs:224-235`, `guard.mjs:335-366`, `commands.mjs:452-456`)
- No refusal message and no skill uses the `! <command>` form. "Run it yourself"
  is always written as prose. (research Q7)
- `git commit` tests cover only the design and worktree phases, from the main
  checkout. (research Q8)

## Desired End State

A user with uncommitted changes at `/dex:worktree` is offered two choices that
both work from inside Claude. Neither loosens the guard. A refused `git commit`
tells the user exactly how to commit it themselves.

## Relevant Existing Patterns

### Pattern 1: The user performs human-only actions

Evidence:
- The approve skill tells the user to run `state.mjs approve` "in their own
  terminal" when the hook did not run. (`dex/skills/approve/SKILL.md`)
- `install-hook` shows the user a line to add to their own hook, rather than
  editing it. (`dex/skills/worktree/SKILL.md` step 5)

Applicability to this change: the same idea. Committing unrelated work before
implementation is the user's action. Dex gives them the exact command.

## Proposed Design

1. **The worktree skill offers two choices instead of a bare stop.** When
   `git status` shows changes outside the artifact folder, the skill:
   - lists them, and says they will not be in the new worktree
   - asks the user to pick one:
     - **Continue without them.** They stay in the main checkout, untouched, and
       the skill proceeds to create the worktree.
     - **Commit them first.** The skill prints a ready-to-paste
       `! git commit -m "<message>" -- <the listed paths>` and waits. It never
       runs the commit itself.
   - still never stashes, resets, checks out over, or cleans.
2. **The guard's `git commit` refusal names the way out.** When the refused
   command is `git commit` (in any phase before implementation), the message adds
   one line. It says that to commit work that is not part of this feature, the
   user can run it themselves by typing `! git commit …` in the prompt. The guard
   decision itself is unchanged.

## End-to-End Flow

```text
/dex:worktree <slug>
  -> git status shows changes outside docs/dex
  -> skill: "These will not be in the worktree. Continue without them, or commit them first?"
       continue -> git worktree add (unchanged path)
       commit   -> skill prints: ! git commit -m "..." -- <paths>
                -> user runs it (as the user, not a tool call; the guard is not involved)
                -> user re-runs /dex:worktree, which now sees a clean tree
```

## Interfaces / Contracts

- Skill text only for (1).
- Guard refusal text for `git commit`: adds a single line containing
  `! git commit`. The allow or deny decision is unchanged for every input.

## Data Changes

Not applicable.

## Security / Authorization

No policy change. Claude still cannot commit before implementation is unlocked.
A `!` command runs as the user, which is already outside the guard. This design
only tells users that option exists.

## Failure Semantics

- The user picks "commit" but does not run the command: `/dex:worktree` still
  sees the changes next time and asks again.
- The user asks Claude to commit anyway: the guard refuses, and its message now
  gives the `!` line. That is not a loop.

## Compatibility

No state or config changes. Existing features are unaffected.

## Observability

Not applicable.

## Resolved Decisions

| Decision | Resolution | Reason |
| -------- | ---------- | ------ |
| Where to fix | The worktree skill and the commit refusal message. The guard policy stays as is. | The stop protects a real risk (changes missing from the worktree). The guard rule is correct. The bug is that nothing offers a path that works. Chosen by the human. |
| Who commits unrelated work before implementation | The user, via a printed `! git commit` line | It keeps "Claude cannot land changes before approval" absolute. Chosen by the human. |
| Which refusal gets the new line | `git commit` only, in every pre-implementation phase | The same trap exists before the worktree phase too. Other commands have no equivalent need. |
| Other guard contradictions found in research | Out of scope, listed as follow-ups | Chosen by the human. |

## Open Questions

- None blocking.

## Alternatives Considered

### Alternative A: Allow `git commit` during the worktree phase

Advantages: Claude could commit for the user. It is fewest steps for the user.

Risks: it loosens the one rule that keeps changes from landing before approval.
It also adds a fourth way of expressing guard exceptions (research found three).

Reason rejected: chosen against by the human.

### Alternative B: Drop the stop and always continue

Advantages: no question asked.

Risks: the user may not notice their changes are missing from the worktree. That
is what happened with `LIVE-CHECKS.md`.

Reason rejected: it removes the one useful warning.

## Non-Goals

- Changing any allow or deny decision in the guard.
- Fixing the other contradictions research found. These include refusal messages
  that disagree on what is allowed, three styles of exception, and the
  `e2e.test.mjs:85` comment.
- Stashing or moving the user's changes.

## Least-Confident Decisions

1. **The `! git commit` wording in a guard message.** The guard's reason text is
   shown to the model. Whether it also reaches the user depends on the model
   relaying it. The skill path is the reliable one. The message line is a
   backstop.
2. **Suggesting `-- <paths>` in the printed commit.** It limits the commit to the
   listed files, which is safer than `-a`. But paths with spaces or odd
   characters need quoting, which the skill must get right.
3. **Adding the line in every pre-implementation phase.** In the questions or
   design phase, a commit request may be someone trying to land feature code
   early. Pointing them to `!` there is still correct, since it is their
   repository. But it is a gentle nudge around the process.

These are the decisions the human reviewer should challenge first.
