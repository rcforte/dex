# Research Questions: Checkpoints after drift

## Objective

Establish the minimum factual understanding of the existing system needed
before designing the change.

## Questions

> Each question must be answerable by reading this repository.
> Each question must be neutral: it must not name a component that does not
> exist yet, and it must not imply a solution.

### System flow

1. What does the `set-slices` command in `dex/scripts/state.mjs` do, step by
   step? List every condition under which it refuses, and what it keeps from a
   previously recorded slice when it rewrites the list.
2. What does the `drift` command in `dex/scripts/state.mjs` change in a
   feature's `state.json`? Which fields does it set, which approvals does it
   affect, and what clears the resulting blocked state?

### Data and persistence

3. How are implementation slices stored in a feature's `state.json`? List every
   field of a slice, what sets each field, and whether the order of the slices
   in the list has any meaning anywhere in `dex/scripts/`.

### Domain ownership

4. Which code in `dex/scripts/` reads the recorded slice list to compute gates,
   status, or the next suggested command? For each place, what does it assume
   about the list (fixed length, order, all complete, etc.)?
5. How does the structure approval relate to the slice list? Is the slice list
   derived from, checked against, or hashed together with
   `05-structure.md` anywhere?

### Backward compatibility

6. How does `dex/scripts/state.mjs` load and normalize an older or existing
   `state.json`? Is there any version field or migration step for slice
   records?

### Error handling

7. Which Dex error messages, skill files (`dex/skills/*/SKILL.md`), or README
   passages tell the user what to do when the slice list must change after
   implementation has started? Quote the advice each one gives.

### Tests

8. Which tests in `dex/tests/` cover `set-slices`, `drift`, and the blocked
   state? What behavior does each assert about changing the slice list after a
   slice has started?

### Existing analogous behavior

9. After a feature's implementation is complete, or its code has been
   approved, what happens in Dex state and gates when earlier-stage work
   changes? Find any existing path where Dex reopens a later stage after an
   earlier one changes.

### Conventions

10. What does the implement skill (`dex/skills/implement/`) instruct the agent
    to do when review or verification uncovers work that is not in the
    approved structure?

## Explicitly excluded from research

Research must not propose the implementation.

Research must not decide the architecture.

Research must not infer the desired solution from the ticket.

Research workers never see the feature intent. They see one question each.

## Human Notes

Add, remove, or rewrite questions here before approval. Deleting a question is
as valuable as adding one: every question costs a research worker.
