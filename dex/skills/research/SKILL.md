---
name: research
description: Run isolated objective codebase research for an approved set of Dex questions, producing 03-research.md. Invoke with /dex:research <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Write, Glob, Grep, Task, Workflow
---

# /dex:research

Answer the approved research questions with facts about the existing system.

## 1. Check the prerequisite

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Proceed only when `gates.questions.status` is `APPROVED`.

If it is `DRAFT`, the questions have not been approved — stop and say so.
If it is `STALE`, the questions changed after approval — stop and say so. Running
research against questions the human has not signed off on wastes the isolation
this stage is built around.

## 2. Run the research workflow

The orchestration lives in a workflow script, not in this prompt:

```text
Workflow tool, script: ${CLAUDE_PLUGIN_ROOT}/workflows/research.js
args: { "slug": "<slug>", "questionsPath": "docs/dex/<slug>/02-questions.md", "maxWorkers": <config.maxResearchWorkers> }
```

Pass `args` as a real JSON object, not a string.

The workflow parses the questions, fans out one isolated probe per question,
verifies findings adversarially, and synthesizes a report. It runs in the
background; its result arrives as a notification.

**The critical property: no worker receives `01-intent.md` or the feature
description.** Workers get one question each. Do not add the intent to their
prompts to be "helpful" — that is exactly the contamination this design prevents.
A worker that knows the desired feature starts reporting where the feature should
go instead of how the system works today.

### If the Workflow tool is unavailable

Fall back to direct subagent delegation, preserving the isolation:

1. Read `02-questions.md` yourself and extract the questions.
2. For each question, launch a `research-probe` subagent whose prompt contains
   **only that question** plus the instruction to report facts with evidence.
   Launch them in one message so they run concurrently.
3. For findings that matter to the design, launch `research-verifier` subagents
   with the question and the candidate findings.
4. Synthesize the report yourself from what came back.

Never send the feature intent to a probe in either path.

## 3. Write the report

Write `03-research.md` from `${CLAUDE_PLUGIN_ROOT}/templates/research.md`.

Requirements:

- Every FACT carries evidence as `path:startLine-endLine`.
- INFERENCE is labeled INFERENCE and says what it rests on.
- UNKNOWN is labeled UNKNOWN and says what would resolve it.
- A finding whose verification came back UNVERIFIED or CONTRADICTED is recorded
  with that verdict. Do not quietly upgrade it, and do not invent evidence to
  rescue it. An honest unknown is usable; a fabricated fact is not.
- **Existing Patterns** says where patterns exist and where they do not. It never
  says a pattern should be used. That is a design decision and it belongs to the
  human.
- **Contradictions / Ambiguities** is the most valuable section. Where the
  repository disagrees with itself, the design stage must put the choice to the
  human rather than silently inheriting whichever pattern was found first.

If some research failed or returned nothing, say so in **Scope**. Do not fill the
gap with plausible-sounding architecture.

## 4. Record and stop

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" transition <slug> research-complete
```

Print a short summary — how many findings verified, partially verified,
unverified — then:

```text
Artifact:
docs/dex/<slug>/03-research.md

Research is persisted. This is a good place to start a fresh session:
a new context can pick up with /dex:resume <slug>, or continue here.

Next:
/dex:design <slug>
```

Do not begin designing.
