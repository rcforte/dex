---
name: review
description: Run independent multi-angle AI review of a Dex feature's production diff, producing 08-review.md. Invoke with /dex:review <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Write, Glob, Grep, Agent, Workflow
---

# /dex:review

Review the production diff from several independent angles.

**This review records no approval.** A human still reads the code. Say this in the
output every time — a passing AI review reads like permission to skip the human
gate, and it is not.

## 1. Check state

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>
```

Review is worth running when implementation is complete and verification passed.
Reviewing a half-implemented change produces findings about code that was about to
change anyway.

## 2. Choose the review dimensions

Pick the ones the change actually touches. Running every category on every change
produces noise, and noise gets skimmed.

Available dimensions: `correctness`, `design-conformance`, `regressions`, `security`, `error-handling`, `concurrency-transactions`, `test-adequacy`, `architecture-boundaries`, `backward-compatibility`.

Pass these exact names. The workflow has a brief for each one; any other name gets
a generic brief.

Choose from the diff: schema changes pull in backward compatibility; a new
endpoint pulls in security; anything touching `@Transactional` or locks pulls in
concurrency. Typically three to five dimensions.

## 3. Run the review workflow

Get the exact diff the human will approve:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" diff-hash <slug> --json
```

It prints `dir`, `baseSha` and `tree`. The Workflow tool only loads scripts from
inside the project, so copy the workflow in:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" stage-workflow review
```

It prints the path of the copy. If it fails, stop and tell the user its message.
Then:

```text
Workflow tool, scriptPath: <the path stage-workflow printed>
args: {
  "slug": "<slug>",
  "dimensions": ["correctness", "design-conformance", "test-adequacy"],
  "worktree": "<dir>",
  "base": "<baseSha>",
  "tree": "<tree>",
  "verification": <gates.verification from the check output>,
  "stateScript": "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs",
  "templatesDir": "${CLAUDE_PLUGIN_ROOT}/templates",
  "artifactRoot": "<config.artifactRoot>",
  "stateRoot": "<config.stateRoot>"
}
```

Pass `args` as a real JSON object.

If the Workflow tool refuses to start the script, stop and tell the user its
message, and suggest `/dex:doctor`. Do not fall back to subagents and do not paste
the script inline.

**When the result arrives:**

- If `ok` is `false`, stop and tell the user the `reason`. Do not review another
  way and do not write the report yourself.
- If `ok` is `true`, the workflow has already written `08-review.md`. Do not write
  it again. Record the result with the `recordCommand` it returns (step 5).

The workflow reviews each dimension in an isolated context, then runs a
consolidation pass that deduplicates findings, checks each one's evidence, drops
style trivia, and ranks by severity.

Reviewers receive the intent, the approved design, the approved structure, the
diff, and the verification result. Unlike research, review is *supposed* to know
what was intended — that is how it checks conformance.

### If the Workflow tool is unavailable

Launch one `implementation-reviewer` subagent per dimension in a single message,
then consolidate the findings yourself.

## 4. The report

On the workflow path the report is already written. On the fallback path, write
it from `${CLAUDE_PLUGIN_ROOT}/templates/review.md`.

Every finding carries: severity, file, line or symbol, claim, evidence, impact,
recommended correction, confidence.

Severity is BLOCKER, HIGH, MEDIUM, or LOW.

Drop: formatting, naming preference, "consider extracting this" with no defect
behind it, and anything you could not ground in the code. Findings you could not
substantiate go under **Unverified Concerns**, marked as such, so they are neither
lost nor trusted.

Conclusion is `PASS` or `REMEDIATION REQUIRED`.

## 5. Record

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" record-review <slug> pass --blockers 0
```

or:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" record-review <slug> remediation-required --blockers 2 --high 3
```

The script refuses a `pass` conclusion with a non-zero blocker count.

## 6. Report

```text
AI review: <PASS | REMEDIATION REQUIRED>
BLOCKER <n>   HIGH <n>   MEDIUM <n>   LOW <n>

Report: docs/dex/<slug>/08-review.md

AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW.

Next: read the production diff yourself.
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" <slug> --review
```
