# Dex

A brownfield software engineering harness for Claude Code.

Dex splits feature work into staged lifecycle commands, isolates each stage's
context, and enforces the human approval gates with a program rather than a
prompt.

```text
DO NOT OUTSOURCE THE THINKING.

Use agents to create leverage.
```

**Dex is a leverage system, not an accountability transfer system. The engineer
remains responsible for the design and production code.**

## Who owns what

| Humans own | Agents provide | Deterministic tooling provides |
| ---------- | -------------- | ------------------------------ |
| intent | codebase exploration | state |
| architecture | context compression | gate enforcement |
| design decisions | alternative generation | artifact integrity |
| important tradeoffs | implementation | workflow sequencing |
| production code | verification assistance | verification evidence |
| final acceptance | review assistance | |

## What Dex is not

- Not a fully autonomous software factory.
- Not a replacement for engineers.
- Not a way around code review.
- Not a giant multi-agent swarm. It uses parallelism for independent research and
  review, and stays sequential where code is shared.

## Installation

Development use, from the directory containing `dex/`:

```bash
claude --plugin-dir ./dex
```

Validate the plugin:

```bash
claude plugin validate ./dex
claude plugin validate --strict ./dex
```

Check the environment:

```text
/dex:doctor
```

**Requirements:** Node.js 18 or later, and git. No `npm install` — the helper
scripts use only Node built-ins, deliberately, so the plugin works on any
developer machine without a dependency step.

## Lifecycle

```text
Intent
  ↓
Questions
  ↓
Research
  ↓
Design               [human gate]
  ↓
Structure            [human gate]
  ↓
Plan
  ↓
Worktree
  ↓
Implement            (one checkpoint at a time)
  ↓
Verify
  ↓
AI Review            (supplemental)
  ↓
Human Code Review    [human gate]
  ↓
PR
```

## Commands

| Command | What it does |
| ------- | ------------ |
| `/dex:start <description>` | Capture the problem as `01-intent.md` and initialize state. No research, no design, no code. |
| `/dex:questions <slug>` | Turn intent into objective research questions in `02-questions.md`. Does not answer them. |
| `/dex:approve questions <slug>` | Record human approval of the question list, bound to its hash. Only you can approve: the approval is recorded when you type the command. |
| `/dex:research <slug>` | Fan out isolated probes, verify their findings adversarially, synthesize `03-research.md`. |
| `/dex:design <slug>` | Interactive design discussion. Surfaces competing patterns and maintains `04-design.md`. |
| `/dex:approve design <slug>` | **Human gate.** Record approval of the design. |
| `/dex:structure <slug>` | Program structure and vertical checkpoints in `05-structure.md`. |
| `/dex:approve structure <slug>` | **Human gate.** Record approval of the structure. |
| `/dex:plan <slug>` | Tactical implementation plan `06-plan.md` and the checkpoint list in state. |
| `/dex:worktree <slug>` | Create an isolated git worktree and branch next to the repository, and install the git pre-push hook. Never discards uncommitted work. |
| `/dex:implement <slug> [Sn]` | Implement one checkpoint, verify it, log it, then stop. |
| `/dex:verify <slug>` | Run the project's real verification commands and persist the exit codes. |
| `/dex:review <slug>` | Independent multi-angle AI review into `08-review.md`. Records no approval. |
| `/dex:approve code <slug>` | **Human gate.** Record that a human read the production diff, bound to the exact code (a git tree). |
| `/dex:pr <slug>` | Prepare and optionally create the pull request, with the feature documents included. The only command that may push. |
| `/dex:status <slug>` | The gate board, stale approvals, and the next legal action. |
| `/dex:next <slug>` | Just the next legal command, computed by the state machine. |
| `/dex:resume <slug>` | Resume in a fresh context, loading only what the next phase needs. |
| `/dex:doctor` | Check runtime, git, plugin components, hooks, and writability. |

## Why questions are separated from research

Research workers never see the feature request. They receive one question each.

This prevents two failure modes.

**Ticket leakage.** A worker told "we are adding portfolio optimization" starts
reporting where optimization *should* go. That is a design opinion, and once it
lands in a research document it travels downstream looking like a fact about the
codebase.

**Opinion contamination.** A question that names a component that does not exist
yet has already chosen the answer:

```text
GOOD  Which domain component currently owns portfolio persistence?
BAD   Where should we add PortfolioOptimizationService?
```

Separating the stages also puts the question list in front of a human before six
workers spend their contexts on it. Deleting a weak question is as valuable as
adding a good one.

Research findings are labeled `FACT`, `INFERENCE`, or `UNKNOWN`. A fact carries
evidence as `path:startLine-endLine`. An unsupported architectural opinion is not
allowed to masquerade as codebase research.

## Why design and structure are separate

```text
Design    = where are we going?
Structure = how do we get there safely?
```

Design is a conversation about the destination: patterns, tradeoffs, contracts,
failure semantics. Structure is the route: types, signatures, file locations,
call flow, execution order, and what verifies each step.

Both are human gates because disagreement is cheap to fix here. Changing

```text
"use PortfolioService rather than introducing PortfolioConstructionService"
```

costs a sentence before implementation and two thousand lines after it.

## Why the plan is separate

The tactical plan exists for the implementation agent. Humans review intent,
design, structure, and the actual code. Spot-check the plan; do not read it line
by line. Turning it into a second implementation that a human must review defeats
the purpose.

## Why code review remains mandatory

Actual code diverges from plans. Dex never claims that reviewing a plan removes
the need to review the code, or that a passing AI review means the code is
approved.

AI review is supplemental. Tests are supplemental. Neither replaces engineering
ownership. `/dex:status` states it plainly:

```text
Verification         PASS
AI Review            PASS
Human Code Review    REQUIRED
PR                   BLOCKED
```

Human approval is bound to a SHA-256 fingerprint of the production diff,
including untracked new files. Change the code after approving it and the
approval goes stale:

```text
HUMAN CODE APPROVAL STALE: the diff changed after approval.
```

Editing Dex's own documents does not invalidate it — only production code does.

## Vertical plans

Structure favors executable vertical checkpoints over horizontal layers.

```text
AVOID                         PREFER
Phase 1  database             S1  entry → application → domain → persistence
Phase 2  repositories             → observable result → verification
Phase 3  services             S2  deepen the same path with real behavior
Phase 4  API                  S3  add the next capability or edge case
Phase 5  frontend
Phase 6  tests
```

Horizontal sequencing means nothing is observable until the end — which is
exactly when a wrong assumption has become expensive. Tests are never their own
phase.

When work genuinely cannot be verticalized, the structure document must record a
**Horizontal dependency exception** with the reason and the earliest executable
checkpoint.

## Tracer bullets

These are different ideas, and conflating them produces bad plans:

- A **vertical slice** describes the *shape* of a change: end-to-end through the
  relevant layers.
- A **tracer bullet** describes the *purpose and depth* of an early slice: the
  thinnest end-to-end implementation needed to prove the architectural path
  works.

So a tracer bullet is a thin vertical proof, and the slices after it are
production-quality deepening of the same architecture. Not every slice is a
tracer.

A tracer bullet is **optional**. Use one when real integration or architecture
uncertainty exists:

```text
new UI → API → service → unfamiliar backend integration
new event → broker → processor → storage
new API → legacy subsystem
a new persistence technology
a cross-service feature
```

Skip it for localized behavior changes, well-understood refactors, and simple
business rule extensions. Every structure document states the decision
explicitly:

```text
Tracer bullet required: YES | NO
Reason:
```

## Context hygiene

Long conversations degrade. Dex persists each stage's decisions into a concise
artifact, so a fresh session can continue without replaying anything:

```text
conversation → artifact → fresh context resumes from the artifact
```

At any stage boundary you can start a new Claude Code session and run:

```text
/dex:resume <slug>
```

`/dex:resume` loads only what the next phase requires. Implementing checkpoint S3
reads the design, the structure, the S3 section of the plan, and the previous
checkpoints' log summaries — not the whole plan and not the research report.

The workflow stays fully resumable even if the session disappears.

## Brownfield authority order

When these conflict, stop and reconcile rather than improvising:

```text
Repository reality
    >
approved design intent
    >
approved structure
    >
tactical plan
    >
model recollection
```

Concretely: before design, existing code beats assumptions. Before
implementation, current code beats a stale plan. Before review, the actual diff
beats the implementation summary.

If implementation discovers that the repository invalidates the approved design,
it records **design drift** and the feature blocks until a human revises and
re-approves the affected artifact. Dex unblocks the feature by itself once every
document approval is current again. Silently improvising a different architecture
is how a feature ends up as something nobody approved.

## What is enforced deterministically

Two hooks and a git hook enforce the gates. Prompts only describe them.

**Approvals come only from you.** A `UserPromptSubmit` hook
(`scripts/approve-hook.mjs`) sees the text you type before the model does. When
it is exactly `/dex:approve <gate> <slug>`, the hook records the approval. The
model cannot trigger this hook, cannot run the approve command itself, and cannot
write to `.dex/`, where approvals and gate state live. As a backup you can run
`node <dex>/scripts/state.mjs approve <gate> <slug>` in your own terminal.

**A `PreToolUse` hook (`scripts/guard.mjs`)** reads each tool call and the state
machine. It refuses three things:

1. **Recording an approval or writing to `.dex/`**, in every phase.
2. **Changing the repository** before the questions, design and structure are
   approved and current, the plan exists and the worktree is ready. Writing inside
   `docs/dex/` stays allowed. Shell changes are refused too: `git commit`, `rm`,
   `mv`, `touch`, `sed -i`, formatters that rewrite files, package installs,
   database migrations, redirects into the repository, and inline scripts that
   write files.
3. **Publishing** until every approval is current, implementation is complete,
   verification passed on the current code, AI review passed on the current code,
   the human approved the current code, and HEAD holds exactly that code.
   Publishing means `git push` in any form, PR commands, write calls to the
   GitHub or GitLab API, and package or image uploads.

Shell commands are parsed, not pattern-matched (`scripts/shell.mjs`,
`scripts/commands.mjs`): quotes, heredocs, `$(...)`, `sh -c`, `eval`, wrappers
such as `env` or `sudo`, and git options and aliases are all followed. Paths are
resolved from the command's own folder, with `..` and symlinks followed, and the
feature worktree counts as the repository.

Read-only inspection is never refused: `git status`, `git diff`, `git log`,
`find`, `grep`, and test and build commands all pass through. A guard that blocks
`git status` gets switched off, and then it protects nothing.

If no Dex feature is active, nothing is gated. If Dex cannot tell which gates
apply (unreadable state, several active features with none selected, a crash in
the guard), it refuses changes and publishing and still allows reading.

**The git pre-push hook** (`scripts/pre-push.mjs`) is the backstop for
publishing. `/dex:worktree` installs it. git runs it before any push, however the
push was started, and it refuses a `dex/*` branch whose feature has not passed
its gates or whose pushed commit is not exactly the approved code. It never
overwrites an existing hook; `/dex:doctor` reports whether it is installed.

**What the guard cannot stop.** Reading commands cannot catch everything. A
script file that writes into the repository before implementation starts
(`python tools/gen.py`) is not seen. The pre-push hook covers publishing; nothing
covers that.

Other invariants the scripts enforce, not the prompts:

- An approval is bound to the exact content approved. The design approval also
  records the questions it rested on, and the structure the design; re-approving
  the earlier document with new content makes the later one stale.
- The code approval is bound to a git tree: the feature checkout as `git add -A`
  would commit it, minus the feature's own documents. Staging and committing do
  not change it; any real change does.
- Verification and AI review results apply only to the code they checked.
- Verification cannot be recorded as PASS while any command exited non-zero, and
  neither verification nor review can be recorded before every checkpoint is done.
- An AI review with BLOCKER findings cannot conclude PASS.
- A checkpoint must be started before it is finished, and recorded checkpoints
  cannot silently disappear.
- Code approval is refused when there is no diff, no known base commit, or no git.
- Secrets are scrubbed from everything Dex stores.
- State writes are atomic (temp file, fsync, rename) and hold a per-feature lock.

## Files Dex creates in your repository

```text
.dex/
├── config.json                  repository defaults (never overwritten)
├── active                       the current feature slug
├── _workflows/                  copies of the workflow scripts, for the Workflow tool
└── <feature-slug>/
    ├── state.json               the state machine
    └── events.jsonl             append-only audit log

docs/dex/
└── <feature-slug>/
    ├── 01-intent.md
    ├── 02-questions.md
    ├── 03-research.md
    ├── 04-design.md             [human gate]
    ├── 05-structure.md          [human gate]
    ├── 06-plan.md
    ├── 07-implementation-log.md
    ├── 08-review.md
    └── 09-pr.md
```

The event log records decisions and hashes. It never records prompts,
credentials, or environment contents.

`init` lists `.dex/` in the repository's local ignore file (`.git/info/exclude`),
so it never shows up in `git status` and is never committed.
`.dex/_workflows/` holds copies of the plugin's workflow scripts. The Workflow
tool only loads scripts from inside the project, so `/dex:research`,
`/dex:review` and `/dex:doctor` refresh the copies each time they run. The copies
go in the checkout Claude Code runs in, so a session opened in a linked worktree
gets its own `.dex/_workflows/` there. `/dex:pr` copies
`docs/dex/<feature-slug>/` into the worktree, so the documents travel with the
PR. `/dex:worktree` also installs a git hook at `.git/hooks/pre-push`.

## Configuration

`.dex/config.json` is created on first use and never overwritten.

```json
{
  "schemaVersion": 1,
  "strictGates": true,
  "requireWorktree": true,
  "requireHumanCodeApproval": true,
  "requireAiReview": true,
  "reviewCadence": "final",
  "maxResearchWorkers": 6,
  "artifactRoot": "docs/dex",
  "stateRoot": ".dex"
}
```

`reviewCadence` controls when a human reads code during implementation:

- `slice` — after every checkpoint
- `checkpoint` — at structural risk points, including after the tracer
- `final` — before the PR

Whatever the cadence, final human code approval is mandatory while
`requireHumanCodeApproval` is true.

Unknown configuration fields are reported as warnings and never change behavior,
so a typo like `requireHumanCodeReview` cannot silently switch off a gate.

- `strictGates: false` lets you approve documents out of order. It never removes
  an approval that implementation or publishing needs.
- `requireWorktree` is read every time, so changing it affects features already
  in progress.
- `maxResearchWorkers` limits how many research agents run at once (1 to 24).
  Every approved question is researched.
- `artifactRoot` and `stateRoot` must be folders inside the repository. The config
  file itself always stays at `.dex/config.json`.

## Command-line tool

Every skill works through `scripts/state.mjs`. You can run it yourself from the
repository: `node <dex>/scripts/state.mjs <command>`. `help` lists the commands.

| Command | What it does |
| ------- | ------------ |
| `init <slug> --title "..."` | Create a feature. |
| `status [slug]`, `check [slug]`, `next [slug]` | The gate board, the gate report as JSON, the next command. |
| `approve <gate> <slug>` | Record an approval. Refused when the model runs it. |
| `transition <slug> <event>` | Log a stage event. Opens no gate. |
| `set-slices <slug> "S1:name" ...` | Record the checkpoints. `--replace` allows dropping recorded ones before any has started. |
| `start-slice`, `finish-slice`, `block-slice` | Move one checkpoint through its states. |
| `verification <slug> pass\|fail\|reset` | Record test results with their exit codes. |
| `record-review <slug> pass\|remediation-required` | Record the AI review conclusion. |
| `record-worktree <slug> <branch> <path> --base <ref>` | Record the feature worktree and pin its base commit. |
| `install-hook` | Install the git pre-push hook. |
| `diff-hash [slug]` | Print the base commit and tree the code approval would cover. |
| `stage-workflow <research\|review>` | Copy a workflow into `.dex/_workflows/` and print its path, so the Workflow tool can load it. |
| `record-pr <slug> --url <url>` | Record the pull request. |
| `drift <slug> --target design\|structure --reason "..."` | Block the feature because the code contradicts a document. |
| `unblock <slug>` | Clear drift by hand. Usually not needed: re-approving does it. |
| `active [slug]`, `list`, `config`, `events [slug]` | Select the current feature, list features, show config, show the event log. |

## When to use Dex, and when not to

**Use it for:** multi-file features, new endpoints, new tables or schema changes,
new screens, cross-layer behavior, architectural change, significant refactors,
complex production bugs needing investigation, and anything with substantial
review risk.

**Skip it for:** a typo, a rename, a copy change, a small config edit, an obvious
one-line fix, or a throwaway prototype identified as throwaway.

Dex only starts when you run `/dex:start`.

## Subagents

Four agents, each for context isolation rather than role-play:

| Agent | Purpose | Tools |
| ----- | ------- | ----- |
| `research-probe` | Investigate one question, report cited facts | Read, Grep, Glob |
| `research-verifier` | Try to falsify research claims against evidence | Read, Grep, Glob |
| `implementation-reviewer` | Find material defects along one dimension | Read, Grep, Glob, Bash (read-only) |
| `verification-analyzer` | Separate a root-cause failure from its cascade | Read, Grep, Glob, Bash (read-only) |

No `chief-architect`. No `qa-manager`. The research probes and verifiers have no
write tools: the research workflow runs them as these two agents. They are also
told not to read `docs/dex/**` or `.dex/**`; that part is an instruction, since a
read-only agent can still read any file. The agent that writes `03-research.md`
is an ordinary workflow agent.

## Workflows

Two JavaScript workflows, used where there is real orchestration:

```text
workflows/research.js   parse questions → fan out probes → verify → synthesize
workflows/review.js     scope diff → parallel dimension reviews → consolidate → report
```

Both report what they could not do. A question whose research failed is listed as
unanswered; a review dimension that returned nothing is listed as not covered.
Neither invents evidence to fill a gap.

Research covers every approved question, including ones you add under Human
Notes. `maxResearchWorkers` only limits how many agents run at once. The skills
pass the plugin's paths to the workflows as arguments, because workflow agents
cannot see the plugin folder on their own.

Human approval never sits in the middle of a workflow — a workflow cannot pause
to hold a design discussion. The state machine sequences the interactive commands
instead.

## Tests

```bash
node --test dex/tests/*.test.mjs
```

Node's built-in test runner, no external framework. Each test builds a throwaway
git repository in a temporary directory; nothing touches the real working tree.

## License

MIT
