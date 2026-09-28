---
name: design
description: Interactive design discussion producing 04-design.md — where are we going, and which existing patterns are intentional. Invoke with /dex:design <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /dex:design

Answer one question with the human: **where are we going?**

This stage is a conversation, not a document generator. Its purpose is alignment
before code exists. Changing "use `PortfolioService` rather than introducing
`PortfolioConstructionService`" costs a sentence now and two thousand lines later.

## 1. Load prerequisites

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Read `01-intent.md` and `03-research.md`. Read specific source files when you need
to check something — research findings can be incomplete, and the repository is
the authority.

Proceed only when research exists. Without it you would be designing from
assumption, which is the failure mode this whole workflow is built to prevent.

## 2. Establish the frame before writing anything

Do not open with a finished design document. Establish, in conversation:

- **Current state** — what exists today, from the research.
- **Desired end state** — what should be true afterward.
- **Candidate patterns** — the ways this repository already does things like this.
- **Open design questions** — what genuinely needs a human decision.
- **Important tradeoffs** — what each option costs.

## 3. Surface competing patterns and ask

Brownfield repositories contain archaeology. Research will usually have found more
than one way the codebase does a given thing:

```text
Pattern A  Portfolio creation routes through PortfolioService.        (12 call sites)
Pattern B  Newer order flows use command handlers.                     (3 call sites)
Pattern C  The legacy reporting module calls repositories directly.
```

Put this choice to the human explicitly. Say which pattern appears newest, which
appears most used, and where each is evidenced.

Do not silently pick one. The most-used pattern is often the one being migrated
away from, and only the human knows which direction is intentional. Choosing
wrong here is cheap to fix now and expensive to fix after implementation.

Ask about anything the research marked as a contradiction, an ambiguity, or an
unknown that affects the design. Ask a few sharp questions, not a survey.

## 4. Maintain 04-design.md

Write it from `${CLAUDE_PLUGIN_ROOT}/templates/design.md`, and update it as the
conversation resolves things. It is the compaction artifact: a fresh session must
be able to read it and know what was decided.

Guidance:

- **Shorter than the implementation.** Optimize for decision leverage. No method
  bodies. If a section would restate code, cut it.
- **Resolved Decisions** records what was settled and why. The "why" is the part
  that survives.
- **Open Questions** stays populated while questions remain open. Do not empty it
  by guessing.
- **Alternatives Considered** records what was rejected and the reason. This is
  what stops the same debate reopening during implementation.
- **Least-Confident Decisions** lists the three decisions the human should
  challenge first. Be honest here — naming your weakest reasoning is the highest
  value thing in the document.

## 5. Stop at the gate

This stage does not approve itself.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" transition <slug> design-updated
```

Print:

```text
Design artifact is ready for human review.

Review:
docs/dex/<slug>/04-design.md

Start with "Least-Confident Decisions" — those are the ones most likely wrong.

When satisfied:
/dex:approve design <slug>
```

Do not proceed to structure. Do not write implementation code. Do not approve.
