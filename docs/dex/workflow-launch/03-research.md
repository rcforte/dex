# Codebase Research: workflow-launch

> Objective findings about the system as it exists today.
> Produced by isolated workers that never saw the feature request.

## Scope

Questions investigated:

1. The steps in the research and review skills that lead up to starting a workflow, the inputs passed to the Workflow tool, and what happens after it returns.
2. What `research.js` and `review.js` read from their environment, and the size of each file.
3. Which files in `dex/` refer to `CLAUDE_PLUGIN_ROOT` or the plugin folder, and what each reference does.
4. How the plugin declares skills, agents, hooks and workflows, and whether a manifest lists workflows.
5. Which directories in a user's project Dex writes to, how each is chosen, and which are covered by `.gitignore` or other hygiene code.
6. What `/dex:doctor` checks about workflows, and how a workflow check passes.
7. What `workflow.test.mjs` and `workflows-run.test.mjs` test, and whether any test runs Dex from a project outside the plugin folder.
8. What `LIVE-CHECKS.md` records about launching workflows and running Dex in another project.
9. Whether other skills or scripts hand a plugin file to a Claude Code tool that might restrict paths, and how they refer to it.
10. Whether the repository records known limits of the Workflow tool.

Questions that could not be answered, and why:

- Q3 (every reference to `CLAUDE_PLUGIN_ROOT`): the probe returned no findings and no verification ran. Partial coverage exists in Q2, Q4, Q6 and Q9.
- Q5 (where Dex writes in a user's project, and hygiene coverage): the probe returned no findings and no verification ran. Only defaults are known, from Q2 (`artifactRoot` defaults to `docs/dex`, `stateRoot` to `.dex`).

## Executive Map

- **Skills** (`dex/skills/<name>/SKILL.md`, 16 of them): prompt instructions for the model. They run plugin scripts through Bash as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"`.
- **Workflows** (`dex/workflows/research.js`, `review.js`): JavaScript bodies run by the external Workflow tool. They get everything through a single `args` object and spawn agents with `agent()`.
- **State CLI** (`dex/scripts/state.mjs`): gate checks, transitions, diff hashing, review recording.
- **Doctor** (`dex/scripts/doctor.mjs`): readiness checks, including a parse-only check of both workflow files.
- **Hooks** (`dex/hooks/hooks.json`): a PreToolUse guard (`guard.mjs`) that restricts where edits and shell writes land, and a UserPromptSubmit approval hook.
- **Agents** (`dex/agents/*.md`, 4): read-only subagents referenced by name.
- **Manifest** (`dex/.claude-plugin/plugin.json`): identity metadata only; lists no components.

## Current System Flow

```text
/dex:research <slug>  (skill, main session; ${CLAUDE_PLUGIN_ROOT} is filled in here)
  -> Bash: node ${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs check <slug>   (stop unless questions APPROVED)
  -> Workflow tool, scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/research.js
       args: { slug, maxWorkers, stateScript, templatesDir, artifactRoot, stateRoot }
       -> agent(): re-runs gate check with args.stateScript
       -> parallel research-probe agents (<= maxWorkers), then research-verifier agents
       -> synthesis agent reads ${templatesDir}/research.md, writes 03-research.md
       <- { ok, reason | unanswered, findings, ... }
  -> ok=false: stop and report reason.  ok=true: read report, list unanswered
  -> Bash: state.mjs transition <slug> research-complete

/dex:review <slug>
  -> state.mjs check <slug>; choose 3-5 dimensions; state.mjs diff-hash <slug> --json
  -> Workflow tool, scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/review.js
       args: { slug, dimensions, worktree, base, tree, verification,
               stateScript, templatesDir, artifactRoot, stateRoot }
       -> per-dimension reviewer agents -> consolidation -> writes 08-review.md
       <- { ok, recordCommand, counts, ... }
  -> run recordCommand (state.mjs record-review ...)

Fallback in both skills when the Workflow tool is unavailable:
  launch the named subagents directly from the main session.
```

## Findings

### Q1: Steps around starting a workflow in the research and review skills

Verification: VERIFIED (three claims narrowed, see below)

#### Facts

- FACT: research/SKILL.md first runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" check <slug>` and proceeds only if `gates.questions.status` is `APPROVED`; it stops on `DRAFT` or `STALE`.
  Evidence: `dex/skills/research/SKILL.md:13-24`
- FACT: It then calls the Workflow tool with `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/research.js` and an `args` JSON object with `slug`, `maxWorkers` (from `config.maxResearchWorkers`), `stateScript`, `templatesDir`, `artifactRoot`, `stateRoot`. It says `args` must be a real JSON object because the workflow's agents cannot see the plugin folder.
  Evidence: `dex/skills/research/SKILL.md:26-43`
- FACT: The skill says the workflow runs in the background and its result arrives as a notification.
  Evidence: `dex/skills/research/SKILL.md:44-48`
- FACT: On `ok: false` the skill stops and reports `reason`, and must not research another way. On `ok: true` it must not rewrite `03-research.md`; it reads it and reports `unanswered`.
  Evidence: `dex/skills/research/SKILL.md:50-56`
- FACT: No research worker receives `01-intent.md` or the feature description.
  Evidence: `dex/skills/research/SKILL.md:58-62`
- FACT: Fallback without the Workflow tool: launch one `research-probe` subagent per question in one message, then `research-verifier` subagents, then synthesize manually.
  Evidence: `dex/skills/research/SKILL.md:64-76`
- FACT: Final step runs `state.mjs transition <slug> research-complete` and points to `/dex:design <slug>`.
  Evidence: `dex/skills/research/SKILL.md:101-121`
- FACT (corrected, PARTIALLY VERIFIED): research.js returns `{ ok: true, slug, artifact, questionCount, answered, unanswered, findings, summary }` on success, and `{ ok: false, slug, reason, ... }` on exactly two paths: gate not approved, and no questions parsed. It has no diff or consolidation failure path.
  Evidence: `dex/workflows/research.js:214-228`, `dex/workflows/research.js:252-260`, `dex/workflows/research.js:454-463`
- FACT: review/SKILL.md runs `state.mjs check <slug>`, then has the model choose dimensions from a fixed list of nine names, typically three to five.
  Evidence: `dex/skills/review/SKILL.md:17-39`
- FACT (corrected, PARTIALLY VERIFIED): It then runs `state.mjs diff-hash <slug> --json`; the command is at lines 43-47 and the statement that it prints `dir`, `baseSha`, `tree` is at line 49.
  Evidence: `dex/skills/review/SKILL.md:41-49`
- FACT: It calls the Workflow tool with `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/review.js` and `args` containing `slug`, `dimensions`, `worktree`, `base`, `tree`, `verification`, `stateScript`, `templatesDir`, `artifactRoot`, `stateRoot`.
  Evidence: `dex/skills/review/SKILL.md:51-67`
- FACT: On `ok: false` the review skill stops and reports `reason`. On `ok: true` it must not rewrite `08-review.md` and records the result with the returned `recordCommand`.
  Evidence: `dex/skills/review/SKILL.md:69-75`
- FACT: Reviewers, unlike probes, receive the intent, design, structure, diff and verification result.
  Evidence: `dex/skills/review/SKILL.md:76-82`
- FACT: Review fallback: one `implementation-reviewer` subagent per dimension, then consolidate manually.
  Evidence: `dex/skills/review/SKILL.md:84-87`
- FACT: review.js returns `{ ok: true, ..., humanReviewStillRequired: true, recordCommand }`, where `recordCommand` is a literal `state.mjs record-review ...` command string; failures return `{ ok: false, slug, reason, ... }` (diff scoping, consolidation).
  Evidence: `dex/workflows/review.js:395-414`, `dex/workflows/review.js:195-198`, `dex/workflows/review.js:332-341`
- FACT: A test requires every `state.mjs` subcommand named in any SKILL.md to appear in the README's "Command-line tool" section.
  Evidence: `dex/tests/docs.test.mjs:55-60`
- FACT (corrected, PARTIALLY VERIFIED): workflow.test.mjs checks that both workflow files exist and parse as async function bodies, and checks rule phrases in the workflow source itself. It does not compare wording against SKILL.md. A separate file, `workflows-run.test.mjs`, runs both workflows with a fake agent.
  Evidence: `dex/tests/workflow.test.mjs:63-73`, `dex/tests/workflow.test.mjs:129-157`, `dex/tests/workflows-run.test.mjs:1-76`

#### Inferences

- INFERENCE (VERIFIED): The fields the skills read after the call (`ok`, `reason`, `unanswered`, `recordCommand`) are the literal return objects of the workflow scripts.
  Based on: `dex/skills/research/SKILL.md:50-56`, `dex/workflows/research.js:454-463`, `dex/skills/review/SKILL.md:69-75`, `dex/workflows/review.js:395-414`
- INFERENCE (VERIFIED): Both skills share one shape: state check before, Workflow call with plugin paths in `args`, branch on `ok` after, and a subagent fallback that keeps the same context rules.
  Based on: `dex/skills/research/SKILL.md:13-76`, `dex/skills/review/SKILL.md:17-87`

#### Unknowns

- UNKNOWN: How the Workflow tool itself runs and delivers its result. It lives outside this repository.
- UNKNOWN: Where `config.maxResearchWorkers`, `config.artifactRoot`, `config.stateRoot` are loaded from. Resolved by reading the config loader in `dex/scripts/`.

Extra context from verification: review.js's default dimensions (`correctness`, `design-conformance`, `error-handling`, `test-adequacy`; `review.js:41`) differ from the example list in the skill's Workflow block. research.js's probe rules forbid probes from reading `artifactRoot/**` and `stateRoot/**` (`research.js:144-175`).

### Q2: What the workflow scripts read from their environment

Verification: VERIFIED (two claims narrowed)

#### Facts

- FACT: research.js is 463 lines; review.js is 414 lines.
  Evidence: `dex/workflows/research.js:1-463`, `dex/workflows/review.js:1-414`
- FACT: Each file's only environment read is the global `args`, as `const input = args || {}`. Neither uses `process.env`, `__dirname`, `import.meta`, `process.argv`, `require`, `import`, or any filesystem call.
  Evidence: `dex/workflows/research.js:31`, `dex/workflows/review.js:24`
- FACT (corrected, PARTIALLY VERIFIED): research.js reads from `args`, with defaults: `slug` ('unknown-feature'), `artifactRoot` ('docs/dex'), `stateRoot` ('.dex'), `stateScript` ('state.mjs'), `templatesDir` (null), `questionsPath`, `researchPath`, `probeAgentType` ('dex:research-probe'), `verifierAgentType` ('dex:research-verifier'). `maxWorkers` defaults to 6 unless positive, and is capped at 24 with no lower clamp.
  Evidence: `dex/workflows/research.js:32-42`
- FACT: review.js reads `slug`, `base` (''), `tree` (''), `worktree` ('.'), `stateScript` ('state.mjs'), `artifactRoot` ('docs/dex'), `stateRoot` ('.dex'), `reviewPath`, `verification` (null), and `dimensions` (default list of four, capped at nine).
  Evidence: `dex/workflows/review.js:25-43`
- FACT: review.js derives `intentPath`, `designPath`, `structurePath` from `artifactRoot` and `slug`; these cannot be set through `args`.
  Evidence: `dex/workflows/review.js:36-38`
- FACT (corrected, PARTIALLY VERIFIED): A comment in research.js says the shells of the agents the workflow spawns lack the plugin root variable, so the `/dex:research` skill resolves plugin paths and passes them in `args`.
  Evidence: `dex/workflows/research.js:26-28`
- FACT: Neither script runs shell commands itself. They put command strings (`node "${stateScript}" check ${slug}`, `git -C ${worktree} --no-pager diff ...`) into `agent()` prompts. review.js's default `worktree` is `.`.
  Evidence: `dex/workflows/research.js:197-211`, `dex/workflows/review.js:31`, `dex/workflows/review.js:149-157`, `dex/workflows/review.js:175-193`

#### Inferences

- INFERENCE (VERIFIED, one citation dropped): Both files are bodies run by an external runner that injects `args`, `agent`, `phase`, `log`, `pipeline`, `parallel`. Test mocks of these globals exist in `dex/tests/helpers.mjs`.
  Based on: `dex/workflows/research.js:31,184,197,234,293,390,406`, `dex/workflows/review.js:24,161,175,259,290,292,355,357`
- INFERENCE (VERIFIED): All environment-dependent behavior goes through `args`.
  Based on: `dex/workflows/research.js:31-42`, `dex/workflows/review.js:24-43`

#### Unknowns

- UNKNOWN: Byte sizes of the two files. Resolved by `wc -c`.
- UNKNOWN: How the runner populates `args`. The runner is outside this repository.

### Q3: References to `CLAUDE_PLUGIN_ROOT` in `dex/`

Verification: UNVERIFIED (no findings returned; verification missing)

#### Facts

- None gathered for this question. Related facts appear elsewhere: every skill uses `${CLAUDE_PLUGIN_ROOT}` in Bash commands and template paths (Q9); `hooks.json` uses it in hook commands (Q4, Q9); doctor.mjs reads it to locate plugin files (Q6, and Q9 extra context: `dex/scripts/doctor.mjs:27-29`); workflow files never reference it, enforced by a test (Q9: `dex/tests/workflows-run.test.mjs:40-53`).

#### Unknowns

- UNKNOWN: A full list of references and what each does. Resolved by `grep -rn CLAUDE_PLUGIN_ROOT dex/`.

### Q4: How the plugin declares its components

Verification: VERIFIED (one claim narrowed)

#### Facts

- FACT: `dex/.claude-plugin/plugin.json` holds only `$schema`, `name`, `displayName`, `version`, `description`, `author`, `homepage`, `license`, `keywords`. It has no skills, agents, hooks or workflows key.
  Evidence: `dex/.claude-plugin/plugin.json:1-20`
- FACT: Skills are one folder each under `dex/skills/<name>/SKILL.md` with frontmatter (`name`, `description`, `disable-model-invocation`, `argument-hint`, `allowed-tools`). There are 16.
  Evidence: `dex/skills/research/SKILL.md:1-7`, `dex/skills/start/SKILL.md:1-7`
- FACT: Agents are `dex/agents/*.md` with frontmatter (`name`, `description`, `tools`, `model`): research-probe, research-verifier, implementation-reviewer, verification-analyzer.
  Evidence: `dex/agents/research-verifier.md:1-6`, `dex/agents/research-probe.md:1-6`, `dex/agents/implementation-reviewer.md:1-6`, `dex/agents/verification-analyzer.md:1-6`
- FACT: Hooks are declared in `dex/hooks/hooks.json` (PreToolUse and UserPromptSubmit), each running a script via `${CLAUDE_PLUGIN_ROOT}`.
  Evidence: `dex/hooks/hooks.json:1-28`
- FACT: Workflows are `dex/workflows/*.js`, each exporting a `meta` object (`name`, `description`, `phases`). No file lists them; skills refer to them by literal `scriptPath`.
  Evidence: `dex/workflows/research.js:1-11`, `dex/workflows/review.js:1-10`, `dex/skills/research/SKILL.md:26-40`
- FACT: The only JSON files in `dex/` are `hooks.json` and `plugin.json`. There is no marketplace file.
  Evidence: `dex/hooks/hooks.json:1-28`, `dex/.claude-plugin/plugin.json:1-20`
- FACT: A test builds the skill list from the `dex/skills` directory, not the manifest, and checks it against the README command table.
  Evidence: `dex/tests/docs.test.mjs:24-28`
- FACT (corrected, PARTIALLY VERIFIED): A test in docs.test.mjs requires `plugin.json`'s `version` to match the newest CHANGELOG entry; that is the only `plugin.json` reference in docs.test.mjs. Other test files were not checked.
  Evidence: `dex/tests/docs.test.mjs:37-41`
- FACT: A test runs `claude plugin validate --strict` on the plugin, skipped when the `claude` CLI is absent.
  Evidence: `dex/tests/docs.test.mjs:49-53`
- FACT: The README describes "Four agents" and "Two JavaScript workflows" in prose, and "Two hooks and a git hook"; the git pre-push hook is installed by `/dex:worktree`.
  Evidence: `dex/README.md:471-486`, `dex/README.md:488-499`, `dex/README.md:298`, `dex/README.md:395`

#### Inferences

- INFERENCE (VERIFIED): Skills, agents and hooks are found by directory convention, not by manifest entries.
  Based on: `dex/.claude-plugin/plugin.json:1-20`, `dex/tests/docs.test.mjs:24-28`
- INFERENCE (VERIFIED): Workflows are not declared anywhere; they are reachable only through a `scriptPath` written in a skill.
  Based on: `dex/skills/research/SKILL.md:26-40`, `dex/workflows/research.js:1-11`

#### Unknowns

- UNKNOWN: Whether Claude Code's plugin loader discovers `workflows/*.js` by convention, or lets a workflow run by name. Resolved by Claude Code's own documentation or source.
- UNKNOWN: What `claude plugin validate --strict` checks beyond `plugin.json`. Resolved by running it.

### Q5: Directories Dex writes to in a user's project

Verification: UNVERIFIED (no findings returned; verification missing)

#### Facts

- None gathered for this question. From Q2: workflows default `artifactRoot` to `docs/dex` and `stateRoot` to `.dex` (`dex/workflows/research.js:32-42`). Recent commits mention keeping the config file in `.dex/` when `stateRoot` is customised. Q7 shows `advanceTo()` creating a git worktree as a sibling of the repo root (`dex/tests/helpers.mjs:115-143`).

#### Unknowns

- UNKNOWN: Every write location, how each is chosen, and which are covered by `.gitignore` or hygiene code. Resolved by reading `dex/scripts/lib.mjs`, `state.mjs` and `dex/tests/hygiene.test.mjs`.

### Q6: What `/dex:doctor` checks about workflows

Verification: VERIFIED

#### Facts

- FACT: The skill runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"` and prints the output verbatim; it exits non-zero when something is broken.
  Evidence: `dex/skills/doctor/SKILL.md:9-13`
- FACT: `runDoctor()` runs a fixed list of checks and returns `{ ok, checks, text }`.
  Evidence: `dex/scripts/doctor.mjs:95-254`
- FACT: Only two workflow checks exist, a hard-coded loop over `research.js` and `review.js`, named `Workflow research.js` and `Workflow review.js`.
  Evidence: `dex/scripts/doctor.mjs:175-178`
- FACT: `checkWorkflow` looks under `${PLUGIN_ROOT}/workflows/`. It fails if the file is missing, if a regex finds no `export const meta = {...}` block, or if that block lacks `name:` or `description:`.
  Evidence: `dex/scripts/doctor.mjs:74-81`
- FACT: It then rewrites `export const meta =` to `const meta =` and constructs an `AsyncFunction` from the source. A throw fails the check; otherwise it passes with "exports meta and parses". The function is never called.
  Evidence: `dex/scripts/doctor.mjs:82-93`
- FACT: Passing means: file exists, `meta` has `name` and `description`, source parses. It does not check behavior or `phase()` calls.
  Evidence: `dex/scripts/doctor.mjs:73-93`
- FACT: Any FAIL makes doctor print NOT READY; warnings only give "Ready, with N warning(s)."
  Evidence: `dex/scripts/doctor.mjs:235-249`
- FACT: doctor also dynamically imports each script in `dex/scripts/` (except itself) to check it loads.
  Evidence: `dex/scripts/doctor.mjs:154-173`
- FACT: No test targets the workflow checks; `checkWorkflow` is used only in doctor.mjs. Doctor tests cover writing nothing to the repo, failing on an unreadable feature, and pre-push hook status.
  Evidence: `dex/tests/hygiene.test.mjs:169-185`, `dex/tests/shell-guard.test.mjs:343-350`
- FACT: workflow.test.mjs and helpers.test.mjs test the workflows more deeply with their own helpers, not `checkWorkflow`.
  Evidence: `dex/tests/workflow.test.mjs:1-21`, `dex/tests/workflow.test.mjs:508-530`, `dex/tests/helpers.test.mjs:58-90`

#### Inferences

- INFERENCE (VERIFIED): The check is parse-only because workflow scripts need an injected runtime and cannot be imported. A code comment states this.
  Based on: `dex/scripts/doctor.mjs:82-93`

#### Unknowns

- None material.

### Q7: What the two workflow test files test

Verification: VERIFIED (one claim narrowed)

#### Facts

- FACT: workflow.test.mjs is static: it reads plugin files as text under `PLUGIN_ROOT` (the `dex/` folder) because workflows cannot be imported.
  Evidence: `dex/tests/workflow.test.mjs:1-10`, `dex/tests/helpers.mjs:12`
- FACT: It asserts wording and invariants: research never references `01-intent`, review reads design and structure, failed agents are filtered, unanswered questions and uncovered dimensions are reported, frontmatter is well formed.
  Evidence: `dex/tests/workflow.test.mjs:23-58`, `dex/tests/workflow.test.mjs:129-201`, `dex/tests/workflow.test.mjs:240-270`, `dex/tests/workflow.test.mjs:338-377`
- FACT: workflow.test.mjs never creates or uses a project directory.
  Evidence: `dex/tests/workflow.test.mjs:1-531`
- FACT: workflows-run.test.mjs runs both workflows in Node through `runWorkflow()`, which builds an `AsyncFunction` with fake `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`. It sets no working directory and touches no project.
  Evidence: `dex/tests/workflows-run.test.mjs:1-7`, `dex/tests/helpers.mjs:221-268`
- FACT (corrected, PARTIALLY VERIFIED): workflows-run.test.mjs covers: paths arriving through `args`, not `$CLAUDE_PLUGIN_ROOT`; skills using `scriptPath`; the gate check using the given state script; all questions researched with a concurrency cap; a failed question surfacing as unanswered; probes as `dex:research-probe` told to skip Dex folders; the review diff spanning `baseSha..tree`; the PR skill copying feature docs. A failed review dimension is checked only statically in workflow.test.mjs.
  Evidence: `dex/tests/workflows-run.test.mjs:40-53`, `dex/tests/workflows-run.test.mjs:78-113`, `dex/tests/workflows-run.test.mjs:132-160`, `dex/tests/workflows-run.test.mjs:223-228`
- FACT: `makeRepo()` creates a git repo under `os.tmpdir()`, outside the plugin folder. `state()` runs the real `state.mjs` with `cwd` set to that repo. `advanceTo()` drives a feature through the stages and can create a sibling worktree.
  Evidence: `dex/tests/helpers.mjs:21-48`, `dex/tests/helpers.mjs:60-64`, `dex/tests/helpers.mjs:115-143`
- FACT: The "finding 37" and "Q11" tests in workflows-run.test.mjs use these helpers, and Q11 runs real git commit and push to a temp bare origin.
  Evidence: `dex/tests/workflows-run.test.mjs:174-198`, `dex/tests/workflows-run.test.mjs:204-228`

#### Inferences

- INFERENCE (VERIFIED): No test runs `research.js` or `review.js` against a real project directory outside the plugin folder.
  Based on: `dex/tests/helpers.mjs:221-268`, `dex/tests/workflow.test.mjs:1-10`
- INFERENCE (VERIFIED): `state.mjs` is exercised against real temp projects outside the plugin folder.
  Based on: `dex/tests/helpers.mjs:12`, `dex/tests/helpers.mjs:21-64`, `dex/tests/workflows-run.test.mjs:174-228`

#### Unknowns

- UNKNOWN: Whether another test file runs a workflow against a real project. Verification noted `dex/tests/e2e.test.mjs` drives the real state CLI and guard in a real repo, but its tests are marked `test.todo`.

### Q8: What LIVE-CHECKS.md records

Verification: VERIFIED

#### Facts

- FACT: Live checks run in `~/dev/code/dex-sample`, a separate small Node project whose origin is a local bare repo.
  Evidence: `dex/tests/LIVE-CHECKS.md:5-7`
- FACT: The session starts with `cd ~/dev/code/dex-sample && claude --plugin-dir ~/dev/code/dex-harness/dex`, so the plugin folder sits outside the project.
  Evidence: `dex/tests/LIVE-CHECKS.md:9-13`
- FACT: Reset steps: remove worktree `../dex-sample-dex-<slug>`, delete branch `dex/<slug>`, `git clean -fdx`.
  Evidence: `dex/tests/LIVE-CHECKS.md:15-21`
- FACT: A worktree was created at `~/dev/code/dex-sample-dex-greeting-function`, and `/dex:status` gave the same output from both checkouts.
  Evidence: `dex/tests/LIVE-CHECKS.md:32-37`
- FACT: `/dex:research` wrote `03-research.md` once; 6 questions answered, 44 findings verified, 5 partly.
  Evidence: `dex/tests/LIVE-CHECKS.md:64-65`
- FACT: Recorded bug: the skill starts the workflow by its file path in the plugin folder, and the Workflow tool refused it because it only accepts paths inside the project. It was worked around by passing the script text inline. `/dex:review` has the same problem.
  Evidence: `dex/tests/LIVE-CHECKS.md:66`
- FACT: `/dex:review` wrote `08-review.md` once and needed the same workaround.
  Evidence: `dex/tests/LIVE-CHECKS.md:70-71`
- FACT: With a stale research gate, `/dex:research` stopped at step one; the workflow's own gate check is still untested live.
  Evidence: `dex/tests/LIVE-CHECKS.md:72-73`
- FACT: The release check (full run from `/dex:start` to `/dex:pr`) is unchecked.
  Evidence: `dex/tests/LIVE-CHECKS.md:77-79`

#### Inferences

- INFERENCE (VERIFIED): The inline-script workaround was applied by hand during the session. Both skills still say `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/...`.
  Based on: `dex/tests/LIVE-CHECKS.md:66`, `dex/tests/LIVE-CHECKS.md:71`, `dex/skills/research/SKILL.md:26-40`, `dex/skills/review/SKILL.md:41-65`

#### Unknowns

- UNKNOWN: Whether the uncommitted change to LIVE-CHECKS.md (git status shows it modified) alters these entries. Resolved by `git diff dex/tests/LIVE-CHECKS.md`.

Extra context from verification: the same Step 6 section records that the feature slug leaked into one research finding through a directory listing (`dex/tests/LIVE-CHECKS.md:67-69`).

### Q9: Other places a plugin file is handed to a tool

Verification: VERIFIED (three claims narrowed)

#### Facts

- FACT: All 16 skills run plugin scripts through Bash as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs" ...`.
  Evidence: `dex/skills/start/SKILL.md:36-38`, `dex/skills/status/SKILL.md:13`, `dex/skills/doctor/SKILL.md:10`, `dex/skills/research/SKILL.md:15-17`, `dex/skills/review/SKILL.md:19-21`
- FACT (corrected, PARTIALLY VERIFIED): Eight skills (start, questions, design, structure, plan, implement, pr, review) point the model at `${CLAUDE_PLUGIN_ROOT}/templates/<name>.md` and list Read and Write in `allowed-tools`. Wording varies: "Use", "Write it from", "using", or "Start from".
  Evidence: `dex/skills/start/SKILL.md:6,46`, `dex/skills/questions/SKILL.md:6,31`, `dex/skills/design/SKILL.md:6,63`, `dex/skills/structure/SKILL.md:6,30`, `dex/skills/plan/SKILL.md:6,31`, `dex/skills/implement/SKILL.md:6,112-113`, `dex/skills/pr/SKILL.md:6,36`, `dex/skills/review/SKILL.md:6,91-92`
- FACT: Research and review pass resolved plugin paths (`stateScript`, `templatesDir`) to the Workflow tool in `args`. A test asserts no workflow file mentions `CLAUDE_PLUGIN_ROOT` and both skills use `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/...`.
  Evidence: `dex/skills/research/SKILL.md:26-43`, `dex/skills/review/SKILL.md:41-67`, `dex/workflows/research.js:22-28`, `dex/tests/workflows-run.test.mjs:40-53`
- FACT: research.js's synthesis `agent()` prompt says "Use the template at ${templatesDir}/research.md", handing a plugin path to a spawned agent that reads it and writes the report.
  Evidence: `dex/workflows/research.js:406-422`
- FACT (corrected, PARTIALLY VERIFIED): Subagents are invoked by name or type string everywhere they are launched. A header comment in research.js names two agent files by relative path, with no runtime effect.
  Evidence: `dex/skills/research/SKILL.md:69-73`, `dex/skills/review/SKILL.md:86`, `dex/workflows/research.js:41-42`, `dex/workflows/research.js:22-24`
- FACT: The repository's own path restriction is the PreToolUse hook `guard.mjs`, run before Write, Edit, MultiEdit, NotebookEdit, ApplyPatch, Bash, BashOutput, PowerShell, Shell and `mcp__*` calls. It classifies target paths as state, artifact, repo, outside or unknown.
  Evidence: `dex/hooks/hooks.json:1-27`, `dex/scripts/guard.mjs:49-50`, `dex/scripts/guard.mjs:119-154`
- FACT: guard.mjs allows every other tool (including Read and Agent) without a path check.
  Evidence: `dex/scripts/guard.mjs:266-269`
- FACT: `approve-hook.mjs` runs on UserPromptSubmit and does not restrict paths.
  Evidence: `dex/hooks/hooks.json:15-25`

#### Inferences

- INFERENCE (VERIFIED): A plugin file outside the project classifies as `outside` in guard.mjs and is not blocked.
  Based on: `dex/scripts/guard.mjs:119-147`, `dex/scripts/guard.mjs:215`, `dex/scripts/guard.mjs:224-235`, `dex/scripts/guard.mjs:332-333`
- INFERENCE (corrected, PARTIALLY VERIFIED): No skill passes a plugin path as a direct argument to the Agent tool. Inside research.js, the synthesis `agent()` call does embed a plugin template path in its prompt.
  Based on: `dex/skills/research/SKILL.md:26-43,69-73`, `dex/workflows/research.js:406-422`

#### Unknowns

- UNKNOWN: Whether Claude Code itself restricts Read, Write, Bash or Agent on paths outside the project. Outside this repository.
- UNKNOWN: How an agent type like `dex:research-probe` resolves to `dex/agents/research-probe.md`, and whether `agent()` inside a workflow is the same as the Agent tool. Outside this repository.

### Q10: Recorded limits of the Workflow tool

Verification: VERIFIED

#### Facts

- FACT: readme.md says research and review work best with the Workflow tool and fall back to slower one-by-one agents without it.
  Evidence: `readme.md:216-217`
- FACT: The Workflow tool expects `scriptPath` for a file, not `script` ("confirmed").
  Evidence: `review-findings.md:300-318`
- FACT: `CLAUDE_PLUGIN_ROOT` is not exported to Bash commands, from the main session or subagents. Workflows that used it resolved to `/scripts/state.mjs` and failed every run.
  Evidence: `review-findings.md:137-145`
- FACT: A live check on 2026-09-28 found `${CLAUDE_PLUGIN_ROOT}` inside a skill's own text reaches the model as the real plugin path, so skills can pass paths through `args`.
  Evidence: `dex/NOTES.md:5-11`
- FACT: The implementation plan says workflows read paths only from `args` and skills call the Workflow tool with `scriptPath`.
  Evidence: `implementation-plan.md:409-412`
- FACT: Whether `agent()` accepts an agent type is recorded only as something to check.
  Evidence: `implementation-plan.md:417-419`, `review-findings.md:239-246`, `implementation-plan.md:440`
- FACT: CHANGELOG 0.2.0 names these fixes but describes no tool limits.
  Evidence: `dex/CHANGELOG.md:28-30`, `dex/CHANGELOG.md:53-55`

#### Inferences

- INFERENCE (VERIFIED): The recorded limits are only two: the plugin root variable is absent in workflow agents' shells, and the file parameter is `scriptPath`. The Human Notes in `02-questions.md` state the tool's real path rules are not in the repository.
  Based on: `review-findings.md:137-145`, `review-findings.md:300-318`, `dex/NOTES.md:5-11`, `docs/dex/workflow-launch/02-questions.md:74-76`

#### Unknowns

- UNKNOWN: Whether the Workflow tool can run a workflow by name, or which paths it accepts. The five files do not say. The only record of the path refusal and the inline workaround is `LIVE-CHECKS.md` (Q8).

## Existing Patterns

### Pattern: Plugin paths resolved in skill text, passed to workflows through `args`

Where it appears:
- `dex/skills/research/SKILL.md:26-43`, `dex/skills/review/SKILL.md:51-67`, `dex/workflows/research.js:26-42`, `dex/workflows/review.js:24-43`

What it does: the skill's own text, where `${CLAUDE_PLUGIN_ROOT}` is filled in, supplies absolute plugin paths; the workflow reads them only from `args`.

Where it is NOT used: `scriptPath` itself is still a plugin-folder path, not passed through `args`.

### Pattern: Workflow launched by file path (`scriptPath`)

Where it appears:
- `dex/skills/research/SKILL.md:26-40`, `dex/skills/review/SKILL.md:51-67`, pinned by `dex/tests/workflows-run.test.mjs:40-53`

What it does: points the Workflow tool at `${CLAUDE_PLUGIN_ROOT}/workflows/<name>.js`.

Where it is NOT used: no launch by name or inline text exists in any skill. The inline workaround appears only in `dex/tests/LIVE-CHECKS.md:66`.

### Pattern: Plugin scripts run by Bash with `${CLAUDE_PLUGIN_ROOT}` in the command

Where it appears: all 16 skills (Q9); `dex/hooks/hooks.json:1-28`.

Where it is NOT used: inside workflow scripts and their spawned agents, which get `stateScript` from `args`.

### Pattern: Subagent fallback when the Workflow tool is unavailable

Where it appears: `dex/skills/research/SKILL.md:64-76`, `dex/skills/review/SKILL.md:84-87`.

What it does: launches named subagents directly from the main session. Neither skill has a fallback for "tool present but refuses the path".

### Pattern: Workflow return contract (`ok`, `reason`, plus result fields)

Where it appears: `dex/workflows/research.js:214-228,252-260,454-463`, `dex/workflows/review.js:195-198,332-341,395-414`.

### Pattern: Hard-coded workflow list

Where it appears: `dex/scripts/doctor.mjs:175-178`, `dex/tests/workflow.test.mjs:21`.

Where it is NOT used: no manifest or directory scan lists workflows.

## Relevant Tests

- `dex/tests/workflows-run.test.mjs:40-53` — workflows never mention `CLAUDE_PLUGIN_ROOT`; skills launch with `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/...` and pass the four path args.
- `dex/tests/workflows-run.test.mjs:78-160` — runs both workflows with a fake agent (gate, concurrency, unanswered questions, probe types, diff range).
- `dex/tests/workflows-run.test.mjs:174-228` — real `state.mjs` and git in temp repos outside the plugin.
- `dex/tests/workflow.test.mjs:63-73` — both workflow files exist and parse.
- `dex/tests/workflow.test.mjs:129-201` — isolation and failure-reporting phrases in workflow source.
- `dex/tests/workflow.test.mjs:508-530` — `phase()` calls match `meta.phases`.
- `dex/tests/helpers.mjs:221-268` — `runWorkflow()` fake runtime.
- `dex/tests/docs.test.mjs:24-28,37-41,49-60` — skill list vs README, version vs CHANGELOG, `claude plugin validate`, state commands in README.
- `dex/tests/hygiene.test.mjs:169-185`, `dex/tests/shell-guard.test.mjs:343-350` — doctor behavior (not its workflow checks).
- `dex/tests/e2e.test.mjs` — real-repo flow, currently `test.todo`.
- `dex/tests/LIVE-CHECKS.md` — manual checks; the only record of the Workflow tool refusing plugin-folder paths.

## Relevant Configuration

- `dex/.claude-plugin/plugin.json` — plugin identity and version only.
- `dex/hooks/hooks.json` — registers `guard.mjs` (PreToolUse) and `approve-hook.mjs` (UserPromptSubmit).
- `config.maxResearchWorkers`, `config.artifactRoot`, `config.stateRoot` — read by the research skill; loader not located (Q1 unknown). Runtime copy seen at `.dex/config.json`.
- Workflow `args` defaults: `artifactRoot` `docs/dex`, `stateRoot` `.dex`, `maxWorkers` 6 (cap 24), review `worktree` `.`.

## Relevant Dependencies

- Claude Code Workflow tool — external; runs `dex/workflows/*.js`, injects `args`, `agent`, `phase`, `log`, `pipeline`, `parallel`. Its path rules are not recorded in the repository.
- `claude` CLI — optional, used by `dex/tests/docs.test.mjs:49-53`.
- Node.js and git — used by all scripts and tests.

## Contradictions / Ambiguities

- **Skills launch by plugin path; live use shows the tool refuses it.** Both skills say `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/...` and a test pins that wording (`dex/tests/workflows-run.test.mjs:40-53`). LIVE-CHECKS.md records the Workflow tool refusing that path in another project and a manual inline-text workaround (`dex/tests/LIVE-CHECKS.md:66,71`). Automated tests never exercise the real tool, so they pass either way.
- **`scriptPath` recorded as "confirmed" vs refused in practice.** `review-findings.md:307` calls `scriptPath` confirmed; it was likely confirmed while running inside this repository, where the plugin folder is inside the project. This is unstated.
- **Skill says "if the Workflow tool is unavailable, fall back".** A refused path is neither "unavailable" nor `ok: false`, so neither branch in the skills covers it (`dex/skills/research/SKILL.md:50-76`, `dex/skills/review/SKILL.md:69-87`).
- **Two ways of getting a plugin path to a tool.** Main-session skills embed unresolved `${CLAUDE_PLUGIN_ROOT}` text; workflow agents get resolved paths via `args` (`dex/NOTES.md:9-11`, `dex/workflows/research.js:22-28`). The launch path sits in the first group.
- **Plugin path reaches a spawned agent anyway.** research.js hands `${templatesDir}/research.md` (a plugin-folder path) to the synthesis agent (`dex/workflows/research.js:406-422`). Whether that agent can read outside the project is unknown.
- **Review default dimensions differ from the skill's example.** `review.js:41` defaults to four dimensions; the skill's example lists three.
- **Workflow list is duplicated.** doctor (`dex/scripts/doctor.mjs:175-178`) and tests (`dex/tests/workflow.test.mjs:21`) each hard-code the two file names; no manifest exists.
- **Doctor's workflow check is parse-only.** It reads files from the plugin folder with Node, so it passes even when the Workflow tool would refuse to launch them (`dex/scripts/doctor.mjs:74-93`).

## Research Confidence

High-confidence areas:

- The launch steps, `args`, and return contracts of both skills and workflows (Q1, Q2).
- How components are declared and that workflows are listed nowhere (Q4).
- Doctor's workflow check (Q6) and what the tests do and do not cover (Q7).
- What LIVE-CHECKS.md and the review/plan docs record (Q8, Q10).

Low-confidence areas:

- Q3: full inventory of `CLAUDE_PLUGIN_ROOT` references. No findings; UNVERIFIED.
- Q5: where Dex writes in a user's project and hygiene coverage. No findings; UNVERIFIED.
- The Workflow tool's real rules (accepted paths, launch by name, inline scripts) and whether spawned agents can read plugin files. Outside the repository; only one manual observation exists.
- The config loader for `maxResearchWorkers`, `artifactRoot`, `stateRoot`.

## Files Most Relevant to Design

- `dex/skills/research/SKILL.md`
- `dex/skills/review/SKILL.md`
- `dex/workflows/research.js`
- `dex/workflows/review.js`
- `dex/tests/workflows-run.test.mjs`
- `dex/tests/workflow.test.mjs`
- `dex/tests/helpers.mjs`
- `dex/scripts/doctor.mjs`
- `dex/tests/LIVE-CHECKS.md`
- `dex/NOTES.md`
- `review-findings.md`
- `dex/README.md`
- `dex/scripts/guard.mjs`
