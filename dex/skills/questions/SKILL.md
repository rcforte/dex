---
name: questions
description: Turn feature intent into objective research questions as 02-questions.md. Invoke with /dex:questions <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /dex:questions

Convert feature intent into questions about the **existing system**.

You know the feature. The research workers will not — they receive one question
each and nothing else. That isolation only works if the questions stand on their
own, so this stage is where the quality of the research is actually decided.

Do not answer the questions. Do not design. Do not implement.

## 1. Load state and intent

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Read `01-intent.md`. Skim the repository layout enough to use real vocabulary —
if the codebase says "holding" and not "position", your questions should say
"holding".

## 2. Write the questions

Start from `${CLAUDE_PLUGIN_ROOT}/templates/questions.md`.

Every question must pass three tests:

1. **Answerable by reading this repository.** Not by opinion, not by the internet.
2. **Neutral.** It must not name a component that does not exist yet, and must not
   imply an approach.
3. **Standalone.** A worker who has never heard of this feature must be able to
   act on it.

```text
GOOD  Where does portfolio creation enter the backend?
GOOD  Which domain component currently owns portfolio persistence?
GOOD  What transaction boundaries exist around portfolio writes?
GOOD  Which authorization checks execute before persistence?
GOOD  Which tests define the current expected behavior of portfolio creation?
GOOD  Are similar long-running computations implemented elsewhere in this repo?
GOOD  How does the UI currently surface validation errors from this API?

BAD   Where should we add the new PortfolioOptimizationService?
BAD   How should we implement the optimization endpoint?
BAD   Should we use Kafka for this?
BAD   What is the best way to model an optimization run?
```

The bad questions have already chosen an answer. A worker handed one of them will
produce architecture opinions dressed as research findings.

## 3. Choose categories, do not fill all of them

The template lists many categories. Use only the ones this change actually
touches, and delete the rest. A question that exists to fill a heading costs a
research worker and returns nothing.

Aim for roughly 6–12 questions. If you have more than 14, you are probably
researching the whole system instead of the part this change touches.

Cover, when relevant: entry points, request flow, domain ownership, data
ownership, persistence, transactions, authorization, events and async processing,
external dependencies, configuration and flags, observability, error handling,
tests, UI and API conventions, migration conventions, backward compatibility, and
existing analogous behavior.

Prioritize **existing analogous behavior**. "How was the last feature like this
one built here?" usually returns more design leverage than any other question.

## 4. Record and stop

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" transition <slug> questions-generated
```

Print:

```text
Generated <n> research questions.

Review:
docs/dex/<slug>/02-questions.md

Add, delete, or rewrite them — deleting a weak question is as valuable as adding
a good one. Then:

/dex:approve questions <slug>
```

Do not run research.
