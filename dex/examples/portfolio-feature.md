# Example: portfolio optimization

A complete walkthrough on a realistic brownfield codebase — an enterprise
portfolio management system in Java, with a React frontend, that has been through
several architectural eras.

The feature:

```text
Add the ability to run portfolio optimization for an existing investment portfolio.
```

Watch what Dex refuses to decide early. Nothing in the first three stages
mentions an `OptimizerService`, a new database table, Kafka, or a specific
endpoint. Those are all plausible, and any of them could be wrong. They stay
undecided until research and design justify them.

The artifact excerpts below are illustrative, not real output.

---

## 1. `/dex:start`

```text
> /dex:start Add the ability to run portfolio optimization for an existing investment portfolio
```

```text
Created:
docs/dex/portfolio-optimization/01-intent.md

Read it. Intent is the one artifact nobody else can write for you.

Next:
/dex:questions portfolio-optimization
```

`01-intent.md`, abridged:

```markdown
# Feature Intent: Portfolio optimization

## Problem

Portfolio managers rebalance by hand in spreadsheets, then enter target weights
back into the system. The process takes hours per portfolio and the spreadsheet
is not auditable.

## Desired Outcome

A manager can request an optimization for an existing portfolio, see proposed
target weights with the constraints that shaped them, and either apply or discard
the result.

## User / Actor

A portfolio manager with write access to the portfolio.

## Scope

- Request an optimization for one existing portfolio
- Return proposed target weights
- Record which constraints applied

## Non-Goals

- Multi-portfolio or household-level optimization
- Automatically applying results without review
- Changing the existing rebalancing workflow
- Tax-lot optimization

## Constraints

- Must respect existing mandate constraints; a proposal that violates a mandate
  is worse than no proposal
- Regulated: every proposal must be reconstructible for audit
- Optimization can take tens of seconds for large portfolios

## Acceptance Signals

- A manager requests an optimization and receives proposed weights summing to 1
- A proposal that would breach a mandate constraint is rejected with a reason
- The inputs and constraints of each proposal are retrievable afterward

## Unknowns

- Whether an optimization engine already exists in this codebase
- Whether long-running work has an established pattern here
- Where mandate constraints are currently enforced
- Whether "proposal" is an existing domain concept
```

Note the last section. Four things that must not be silently decided.

---

## 2. `/dex:questions`

```text
> /dex:questions portfolio-optimization
```

```text
Generated 11 research questions.

Review:
docs/dex/portfolio-optimization/02-questions.md

Add, delete, or rewrite them — deleting a weak question is as valuable as adding
a good one. Then:

/dex:approve questions portfolio-optimization
```

`02-questions.md`, abridged:

```markdown
### System flow
1. Where do portfolio write operations enter the backend today?
2. How does the API surface operations that take longer than a request timeout?

### Domain ownership
3. Which component owns portfolio holdings and target weights?
4. Is there an existing domain concept for a proposed-but-unapplied change?

### Data and persistence
5. How are portfolio holdings and weights persisted, and by what?
6. What transaction boundaries exist around portfolio writes?

### Authorization
7. Which authorization checks execute before a portfolio is modified, and where
   relative to persistence?

### Existing analogous behavior
8. Does any numerical or optimization computation already exist in this
   repository, and where does it run?
9. Where are mandate or compliance constraints currently evaluated?

### Tests
10. Which tests define the current expected behavior of portfolio writes?

### Conventions
11. How does the frontend currently handle an operation whose result is not
    immediately available?
```

Every question is answerable by reading the repository. None names a component
that does not exist.

The questions this stage deliberately did **not** ask:

```text
BAD  Where should we add OptimizationService?
BAD  Should the optimization run be a new table?
BAD  Should we publish an OptimizationRequested event to Kafka?
BAD  What should the POST /portfolios/{id}/optimize endpoint return?
```

Each has already chosen an answer. A worker handed one would return architecture
opinions formatted as research.

A human then edited the list — deleted two questions about UI styling as
irrelevant, and added question 9 about mandate constraints, which turned out to
be the most consequential question in the set.

---

## 3. `/dex:approve questions`

```text
> /dex:approve questions portfolio-optimization
```

```text
APPROVED: questions
Feature:  portfolio-optimization
Artifact: docs/dex/portfolio-optimization/02-questions.md
SHA-256:  9f2c41e8a7b3...

Editing that file after this point makes the approval stale.

Next: /dex:research portfolio-optimization
```

---

## 4. `/dex:research`

```text
> /dex:research portfolio-optimization
```

Eleven probes run in isolated contexts. **None of them knows the feature.** Each
receives one question and the repository.

```text
Research complete.

11 questions answered
14 findings verified
3 partially verified
2 unverified
1 contradicted

Artifact:
docs/dex/portfolio-optimization/03-research.md

Research is persisted. This is a good place to start a fresh session.

Next:
/dex:design portfolio-optimization
```

`03-research.md`, abridged:

```markdown
## Findings

### Q3: Which component owns portfolio holdings and target weights?

Verification: VERIFIED

#### Facts

- FACT: `PortfolioService` is the only component that writes `Holding` entities.
  Evidence:
  - `src/main/java/com/acme/portfolio/PortfolioService.java:120-163`
  - `src/main/java/com/acme/portfolio/HoldingRepository.java:22-41`

- FACT: Target weights are stored on `Portfolio` as an embedded
  `Map<InstrumentId, BigDecimal>`, not as a separate entity.
  Evidence:
  - `src/main/java/com/acme/portfolio/Portfolio.java:88-104`

### Q4: Is there an existing domain concept for a proposed-but-unapplied change?

Verification: CONTRADICTED

#### Facts

- FACT: `RebalanceProposal` exists and models exactly this: a computed set of
  target weights, persisted, reviewable, and applied by a separate action.
  Evidence:
  - `src/main/java/com/acme/rebalance/RebalanceProposal.java:1-96`
  - `src/main/java/com/acme/rebalance/RebalanceProposalController.java:34-71`

Note: an initial probe finding claimed no such concept existed. The verifier
contradicted it, citing the class above. The corrected finding stands.

### Q8: Does any optimization computation already exist?

Verification: PARTIALLY VERIFIED

#### Facts

- FACT: `ConstraintSolver` performs bounded quadratic optimization and is used by
  the rebalancing module.
  Evidence:
  - `src/main/java/com/acme/rebalance/ConstraintSolver.java:45-201`

Corrected from the original claim that it is "a general-purpose optimizer": it
only handles bounded quadratic problems with linear constraints.

#### Unknowns

- UNKNOWN: whether `ConstraintSolver` handles the constraint types a mandate
  expresses. Resolved by reading `MandateConstraint` subclasses against the
  solver's supported constraint interface.

### Q9: Where are mandate constraints currently evaluated?

Verification: VERIFIED

#### Facts

- FACT: `MandateValidator` runs inside the `PortfolioUnitOfWork` transaction,
  after holdings are staged and before commit.
  Evidence:
  - `src/main/java/com/acme/compliance/MandateValidator.java:60-118`
  - `src/main/java/com/acme/portfolio/PortfolioUnitOfWork.java:140-176`

## Existing Patterns

### Pattern: service-orchestrated write

Where it appears:
- `src/main/java/com/acme/portfolio/PortfolioService.java:120-163` (12 call sites)

### Pattern: command handler

Where it appears:
- `src/main/java/com/acme/orders/PlaceOrderHandler.java:28-77` (3 call sites)

### Pattern: direct repository access

Where it appears:
- `src/main/java/com/acme/reporting/LegacyReportBuilder.java:210-260`

These patterns exist. Which is intentional is not a research question.

## Contradictions / Ambiguities

- Two competing write patterns are live. The command-handler pattern is newer by
  commit date; the service pattern has four times the call sites. The repository
  does not say which direction is intended.

- `RebalanceProposal` and the newer `ProposalDraft` in the orders module model
  overlapping concepts with different lifecycles.
```

That research changed the feature. There is already an optimizer, already a
proposal concept, and mandate constraints are enforced in the unit of work rather
than in the service. A design written before this would have been wrong in three
places.

---

## 5. `/dex:design`

```text
> /dex:design portfolio-optimization
```

This stage is a conversation. It opens by putting the ambiguity to the engineer
rather than resolving it silently:

```text
Research found two live write patterns and one legacy one:

  Pattern A  service-orchestrated write   PortfolioService          12 call sites
  Pattern B  command handler              PlaceOrderHandler          3 call sites
  Pattern C  direct repository access     LegacyReportBuilder        (legacy)

Pattern B is newer by commit date. Pattern A is far more used. The repository
does not say which direction is intentional, and only you know that.

Which should this feature follow?

Three more decisions I am not going to make for you:

1. `RebalanceProposal` already models a computed, reviewable, unapplied set of
   target weights. Should optimization produce a `RebalanceProposal`, or is an
   optimization proposal a distinct concept?

2. `MandateValidator` runs inside `PortfolioUnitOfWork`, after staging and before
   commit. An optimization proposal is never committed as holdings, so that path
   does not apply. Where should mandate constraints be checked for a proposal?

3. `ConstraintSolver` handles bounded quadratic problems with linear constraints.
   Whether mandate constraints fit that shape is UNKNOWN — the research could not
   establish it. Should we confirm this before designing around the solver?
```

The engineer answered: follow Pattern A, because the command-handler pattern was
an experiment that was not adopted. Reuse `RebalanceProposal` rather than
introducing a parallel concept. And yes — confirm the solver's constraint
support first, because the whole design rests on it.

That check found that two of five mandate constraint types are not expressible in
the solver. The design accounts for them explicitly instead of discovering them
during implementation.

`04-design.md`, abridged:

```markdown
## Proposed Design

Optimization produces a `RebalanceProposal` with `source = OPTIMIZATION`, created
by `PortfolioService` (Pattern A), computed by a new `PortfolioOptimizer` that
wraps the existing `ConstraintSolver`.

Mandate constraints are evaluated twice: expressible constraints are passed to
the solver as bounds; the two that are not expressible are checked as a
post-filter, and a proposal that fails is rejected with the violated constraint
named.

No new persistence: `RebalanceProposal` already stores the inputs and the
resulting weights, which satisfies the audit requirement.

## Resolved Decisions

| Decision | Resolution | Reason |
| -------- | ---------- | ------ |
| Write pattern | PortfolioService (Pattern A) | Command handlers were an unadopted experiment |
| Proposal model | Reuse RebalanceProposal | Identical lifecycle; a parallel concept would split it |
| New table | None | RebalanceProposal already records inputs and outputs |
| Async mechanism | Existing JobRunner | Matches how report generation already works |
| Mandate constraints | Solver bounds plus post-filter | Two of five types are not solver-expressible |

## Alternatives Considered

### Alternative A: a new OptimizationRun entity with its own table

Advantages: independent lifecycle and retention.
Risks: two concepts for "proposed weights"; duplicate apply/discard logic.
Reason rejected: the audit requirement is already met by RebalanceProposal.

### Alternative B: publish an event and process asynchronously via the broker

Advantages: matches the orders module; natural retries.
Risks: this repository's broker usage is confined to cross-service messaging.
Optimization is in-service. Adds operational surface for no gain.
Reason rejected: JobRunner already covers in-service long-running work.

## Least-Confident Decisions

1. The post-filter for non-expressible mandate constraints. It may reject a high
   proportion of proposals, which would make the feature frustrating rather than
   broken.
2. Reusing `RebalanceProposal` — if optimization proposals later need different
   retention, splitting them will be painful.
3. That `JobRunner`'s timeout is sufficient for the largest portfolios. Not
   measured.
```

Note that `PortfolioOptimizer` appears here for the first time — after research
established that an optimizer already exists and this is a thin wrapper over it,
not a new subsystem.

---

## 6. `/dex:approve design`

```text
> /dex:approve design portfolio-optimization

APPROVED: design
SHA-256:  3ab7f04c19de...

Next: /dex:structure portfolio-optimization
```

---

## 7. `/dex:structure`

```text
> /dex:structure portfolio-optimization
```

`05-structure.md`, abridged:

```markdown
## Change Surface

### Existing files modified
- `PortfolioService.java` — add `requestOptimization()`
- `RebalanceProposal.java` — add `source` field
- `PortfolioController.java` — add the request endpoint

### New files
- `PortfolioOptimizer.java` — wraps ConstraintSolver, maps mandate constraints
- `MandatePostFilter.java` — checks the two non-expressible constraint types
- `PortfolioOptimizerTest.java`, `PortfolioOptimizationIT.java`

## Important Interfaces

```text
OptimizationRequestId PortfolioService.requestOptimization(PortfolioId, OptimizationParams)
RebalanceProposal     PortfolioOptimizer.optimize(Holdings, Set<MandateConstraint>)
List<Violation>       MandatePostFilter.check(RebalanceProposal, Set<MandateConstraint>)

POST /portfolios/{id}/optimizations  ->  202 { requestId, statusUrl }
GET  /portfolios/{id}/optimizations/{requestId}  ->  200 { status, proposal? }
```

## Implementation Shape

Tracer bullet required: YES

Reason:
Three integration boundaries are unproven together: the HTTP entry point, the
JobRunner async path, and ConstraintSolver called with mandate-derived bounds.
Each works in isolation elsewhere. None has been exercised in this combination,
and the solver's behavior with mandate-derived bounds is the least-confident
decision in the approved design.

Uncertainty the tracer resolves:
Whether a request can traverse controller → service → JobRunner → optimizer →
persisted proposal → status endpoint, with the solver returning a usable result
from real mandate constraints.

### Checkpoint S1 — tracer

Objective:
Prove the path end to end with deliberately minimal behavior.

Vertical path:
POST endpoint → PortfolioService.requestOptimization → JobRunner →
PortfolioOptimizer with a single bounded constraint → persist RebalanceProposal →
GET status returns it

Implementation depth:
One constraint type. No post-filter. No parameter validation. Real solver, real
persistence, real async path — the seams are the point.

Verification:
`PortfolioOptimizationIT.tracerPathProducesPersistedProposal` — posts a request,
polls the status endpoint, asserts a persisted proposal whose weights sum to 1.

Expected approximate change surface:
Six files, roughly 200 lines including the test.

### Checkpoint S2 — real optimization behavior

Objective:
All solver-expressible mandate constraints, real parameters, real weights.

Verification:
`PortfolioOptimizerTest` — a known portfolio and constraint set produce expected
weights within tolerance; an infeasible set produces an explicit infeasible
result rather than an exception.

### Checkpoint S3 — mandate post-filter and rejection

Objective:
The two non-expressible constraint types, and rejection naming the violation.

Verification:
`PortfolioOptimizerTest.rejectsProposalViolatingConcentrationLimit` asserts the
violated constraint appears in the rejection.

### Checkpoint S4 — authorization and error semantics

Objective:
Authorization on both endpoints; timeout and solver-failure behavior.

Verification:
`PortfolioOptimizationIT` — a manager without write access receives 403; a
simulated solver timeout yields a FAILED status, not a hung request.

## Risk Checkpoints

- If S1 shows the solver cannot accept mandate-derived bounds at all, stop. The
  design's central assumption is wrong and it must be revised.
- If S1's async path exceeds the JobRunner timeout on a realistic portfolio,
  return to design — that was least-confident decision 3.
```

Each checkpoint is vertical and observable. Tests are not a phase; each checkpoint
carries its own verification. And S1 is a genuine tracer: thin on behavior,
complete on integration.

---

## 8. `/dex:approve structure`

```text
> /dex:approve structure portfolio-optimization

APPROVED: structure
SHA-256:  bd51c8e2f7a0...

Next: /dex:plan portfolio-optimization
```

---

## 9. `/dex:plan`

```text
> /dex:plan portfolio-optimization
```

```text
Tactical plan ready:
docs/dex/portfolio-optimization/06-plan.md

Recorded 4 checkpoints: S1, S2, S3, S4

This artifact is primarily for the implementation agent. Spot-check it for obvious
divergence from the structure you approved — but plan review is not code review,
and it does not substitute for reading the diff later.

Next:
/dex:worktree portfolio-optimization
```

The plan names files and symbols, and does not write method bodies:

```markdown
#### `src/main/java/com/acme/portfolio/PortfolioService.java`

Change:
Add `requestOptimization(PortfolioId, OptimizationParams)`. Submit to JobRunner
following the pattern at `ReportService:88-104`. Return the request id.

Why:
Pattern A keeps portfolio writes flowing through one component.

Relevant symbols:
`PortfolioService:120` (createPortfolio, for the surrounding conventions),
`ReportService:88-104` (the JobRunner submission pattern),
`JobRunner.submit()`

### Verification Commands

```bash
./gradlew :portfolio:test --tests '*PortfolioOptimizerTest'
./gradlew :portfolio:integrationTest --tests '*PortfolioOptimizationIT'
```

### Stop Conditions

Stop and return to design or structure if:
- ConstraintSolver rejects mandate-derived bounds outright
- JobRunner has no way to report a terminal failure state
- RebalanceProposal cannot carry a `source` field without a migration
```

---

## 10. `/dex:worktree`

```text
> /dex:worktree portfolio-optimization

Worktree recorded.
  branch: dex/portfolio-optimization
  path:   /home/dev/acme-portfolio-dex-portfolio-optimization
  base:   main

Next:
/dex:implement portfolio-optimization S1
```

Uncommitted work in the main checkout was left untouched. Dex inspects
`git status` first and asks rather than stashing.

---

## 11. `/dex:implement` — one checkpoint at a time

```text
> /dex:implement portfolio-optimization S1
```

The agent reads the current code before editing it, which immediately pays off:

```text
Read PortfolioService.java:120-163 and ReportService.java:88-104 before editing.

The plan says to follow ReportService's JobRunner submission pattern.
ReportService actually calls JobRunner.submitWithRetry(), not submit(). The plan
names submit(). Following the code, not the plan.
```

```text
Checkpoint S1 COMPLETE: tracer — end-to-end optimization path
Verification: ./gradlew :portfolio:integrationTest --tests '*PortfolioOptimizationIT'
Remaining: S2, S3, S4

Next: /dex:implement portfolio-optimization S2
```

It stops there. The pause is the point — it is where a human notices the
implementation has gone somewhere they did not intend, while changing course is
still cheap.

### Design drift, caught at S3

```text
> /dex:implement portfolio-optimization S3
```

```text
DESIGN DRIFT recorded. Feature "portfolio-optimization" is blocked.

Reason: MandateConstraint subclasses are resolved through a registry that loads
per-tenant overrides. The approved design treats the constraint set as static and
enumerable, so the post-filter cannot know which constraints apply without the
tenant context.
```

`07-implementation-log.md`:

```markdown
## DESIGN DRIFT

Checkpoint: S3

Discovery:
The approved design assumes mandate constraints are a static enumerable set.
`MandateConstraintRegistry` resolves them per tenant, including overrides loaded
at runtime.

Evidence:
- `src/main/java/com/acme/compliance/MandateConstraintRegistry.java:40-96`
- `src/main/java/com/acme/compliance/TenantConstraintOverride.java:12-58`

Impact:
`MandatePostFilter.check(RebalanceProposal, Set<MandateConstraint>)` cannot be
called correctly without a tenant context. The interface in the approved
structure is wrong, and so is the design's claim that two constraint types are
non-expressible — that count is per tenant.

Required action: return to design.
```

The agent did not improvise a tenant lookup to make it work. The feature blocked,
the engineer revised the design, re-approved it, and implementation resumed.

That is the loop working. The alternative — quietly inventing a tenant resolution
mechanism inside a post-filter — would have shipped an architecture nobody
approved, discovered in review or in production.

---

## 12. `/dex:verify`

```text
> /dex:verify portfolio-optimization

Verification: PASSED
  exit 0  ./gradlew :portfolio:test
  exit 0  ./gradlew :portfolio:integrationTest
  exit 0  ./gradlew :portfolio:checkstyleMain
  exit 0  ./gradlew architectureTest

Next: /dex:review portfolio-optimization
```

---

## 13. `/dex:review`

```text
> /dex:review portfolio-optimization
```

Four dimensions, chosen from the shape of the change: correctness,
design-conformance, concurrency-transactions (the async path), and security (two
new endpoints).

```text
AI review: REMEDIATION REQUIRED
BLOCKER 1   HIGH 2   MEDIUM 3   LOW 1

Report: docs/dex/portfolio-optimization/08-review.md

AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW.
```

```markdown
### BLOCKER

**Authorization is checked after the job is submitted**
`PortfolioController.java:142` · confidence: high

Claim: `requestOptimization` submits to JobRunner before `@PreAuthorize`
evaluates, because the annotation is on the service method and the controller
submits directly.

Evidence: `PortfolioController:142` calls `jobRunner.submitWithRetry` directly;
the `@PreAuthorize` at `PortfolioService:201` is never reached on this path.

Failure scenario: a manager without write access on portfolio 42 posts an
optimization request. The job runs, reads holdings, and persists a proposal. The
403 is never returned because nothing checks.

Impact: unauthorized read of holdings and creation of a proposal.

Recommendation: check authorization in the controller before submission, or route
submission through the service method that carries the annotation.

### MEDIUM

**The rejection message names the constraint type, not the violated instance**
`MandatePostFilter.java:61` · confidence: high

... (further findings omitted)
```

The blocker was fixed, verification re-run, and review re-run to PASS.

Note what this stage did **not** do: it recorded no approval. A passing AI review
moves nothing past the human gate.

---

## 14. The human reads the code

```text
> /dex:status portfolio-optimization
```

```text
DEX: portfolio-optimization
Portfolio optimization

Intent                COMPLETE
Questions             APPROVED
Research              COMPLETE
Design                APPROVED
Structure             APPROVED
Plan                  COMPLETE
Worktree              READY  (dex/portfolio-optimization)

Implementation
  S1 tracer           COMPLETE
  S2 optimization     COMPLETE
  S3 post-filter      COMPLETE
  S4 authorization    COMPLETE

Verification          PASS
AI Review             PASS
Human Code Review     REQUIRED
PR                    BLOCKED
  - human code review is REQUIRED

Next:
/dex:approve code portfolio-optimization
  Read the production diff yourself. AI review does not substitute for this.

READ THE PRODUCTION CODE

Dex cannot do this part. AI review and green tests are supplemental evidence;
they are not an approval. Start with shape, then read every changed file.

  git -C /home/dev/acme-portfolio-dex-portfolio-optimization diff --stat main
  git -C /home/dev/acme-portfolio-dex-portfolio-optimization diff main

Changed files (7 modified, 4 new):
  M   src/main/java/com/acme/portfolio/PortfolioService.java
  M   src/main/java/com/acme/portfolio/PortfolioController.java
  M   src/main/java/com/acme/rebalance/RebalanceProposal.java
  NEW src/main/java/com/acme/portfolio/PortfolioOptimizer.java
  NEW src/main/java/com/acme/compliance/MandatePostFilter.java
  ...

Public API / boundary: PortfolioController.java
Security / authorization: PortfolioController.java, MandatePostFilter.java
Transactions / concurrency: PortfolioOptimizer.java
Tests: PortfolioOptimizerTest.java, PortfolioOptimizationIT.java

For each file ask:
  - Does this match the design I approved, or did it drift?
  - What happens on the failure path?
  - Would I have written this, and would I defend it in review?
  - What is NOT here that should be?

When you have actually read it:
  /dex:approve code portfolio-optimization
```

The engineer read the diff and found something no reviewer had flagged: the
status endpoint returns the full proposal to any authenticated caller who knows
the request id. The AI review checked authorization on the request path and
missed it on the status path.

That is the gate earning its place. Tests passed. AI review passed. A human
reading the code found a real authorization hole.

Fixed, re-verified, re-read.

---

## 15. `/dex:approve code`

```text
> /dex:approve code portfolio-optimization
```

```text
APPROVED: human code review
Feature:   portfolio-optimization
Base:      main
Diff SHA-256: 7c15c4c257eab798670416d5965d042dfc278955120456eacb3bc38d1376a94f

This approval is bound to that diff. Any further production change voids it.

Next: /dex:pr portfolio-optimization
```

If anyone touches production code now — including the agent "improving" something
helpfully — the approval goes stale and the PR is blocked until a human reads the
change again.

---

## 16. `/dex:pr`

```text
> /dex:pr portfolio-optimization
```

```text
Pull request created:
https://github.com/acme/portfolio/pull/1847

Feature "portfolio-optimization" is complete.
```

The PR body records the whole chain, including the diff hash a human approved.

---

## What the workflow prevented

Compare against what a single-pass agent would plausibly have produced from the
feature description alone:

| Plausible early decision | What research and design actually found |
| ------------------------ | --------------------------------------- |
| A new `OptimizerService` | `ConstraintSolver` already exists; the new code is a thin wrapper |
| A new `optimization_run` table | `RebalanceProposal` already models this and satisfies the audit need |
| Kafka for the async path | This repository's broker is for cross-service messaging; `JobRunner` is the in-service pattern |
| A new `OptimizationProposal` concept | Would have split a concept that already exists, duplicating apply/discard |
| `POST /portfolios/{id}/optimize` | Convention here is a resource collection: `/optimizations` returning 202 |
| Command-handler pattern (newest in repo) | An unadopted experiment; the engineer chose the service pattern |
| Static mandate constraint set | Constraints resolve per tenant through a registry — caught as design drift |

Every one of those is a reasonable guess. Five of seven were wrong. None was
detectable from the feature description; all were detectable by reading the
repository first and putting the ambiguities to a human.

## What it cost

Nine human decision points, each small:

1. Edit the research questions (deleted two, added one)
2. Approve the questions
3. Choose between three write patterns
4. Decide whether to reuse `RebalanceProposal`
5. Decide to confirm the solver's constraint support first
6. Approve the design
7. Approve the structure
8. Revise and re-approve the design after drift
9. Read the production diff and approve the code

Decision 3 saved a rewrite. Decision 5 found two unsupported constraint types
before any code existed. Decision 9 found an authorization hole that passed tests
and passed AI review.
