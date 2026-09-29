# Pending Dex bugs

Bugs seen while running Dex on this repository, not yet fixed. Each one is
meant to become its own Dex feature via `/dex:start`.

## 1. Research reports empty answers as "answered"

The research workflow marks every question as answered, even when the worker
for that question returned no findings. The report's count of answered
questions then overstates what research actually found.

## 2. Any code change resets the AI review

The AI review result is tied to the exact code it checked. Any later change
voids it, even a text-only edit. So each fix after a review costs a full new
review of about 300k tokens.

## 3. A finished checkpoint loses its completion after a design change

When a design change is recorded against a finished checkpoint
(`drift --slice S1`), the checkpoint is marked blocked. Once the block clears,
it becomes "in progress" instead of "complete". Its completion is lost.
Found during the `checkpoints-after-drift` research.
