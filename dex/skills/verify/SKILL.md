---
name: verify
description: Run the project's real verification commands for a Dex feature and persist the results as evidence. Invoke with /dex:verify <feature-slug>.
disable-model-invocation: true
argument-hint: <feature-slug>
allowed-tools: Bash, Read, Glob, Grep, Task
---

# /dex:verify

Run this project's verification and record exactly what happened.

## 1. Discover the real commands

Do not assume a build technology. Prefer, in order:

1. Verification commands named in `06-plan.md`.
2. The project's own documentation: `CLAUDE.md`, `AGENTS.md`, `README`, `CONTRIBUTING`.
3. Build files: `package.json` scripts, `pom.xml`, `build.gradle`,
   `build.gradle.kts`, `Makefile`, `justfile`, `Cargo.toml`, `pyproject.toml`,
   `go.mod`, `*.csproj`, `mix.exs`.
4. CI configuration — `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`. CI is
   the most reliable statement of what "passing" means for this repository.

Run in the feature's worktree path.

Categories to cover when the project has them: compile or build, unit tests,
integration tests, lint, format check, type check, architecture tests, contract
tests, static analysis, end-to-end tests.

Do not invent a command. If you cannot find how this project verifies itself, say
so and ask.

## 2. Run them and capture exit codes

The exit code is the evidence. Record it per command.

## 3. Keep the output small but keep the failure

Long logs destroy the context that diagnosing the failure requires. So:

- keep failing test names
- keep the error message and the stack frames needed to locate the cause
- summarize repetitive successful output as a count
- never paste tens of thousands of lines

If a failure is large or confusing, delegate to the `verification-analyzer`
subagent, which separates the primary root cause from cascading failures.

## 4. Persist the result

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" verification <slug> pass \
  --commands-json '[{"command":"./gradlew test","exitCode":0,"category":"unit"},{"command":"./gradlew integrationTest","exitCode":0,"category":"integration"}]'
```

or on failure:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" verification <slug> fail \
  --commands-json '[{"command":"./gradlew test","exitCode":1,"category":"unit","summary":"PortfolioOptimizationTest.rejectsNegativeWeights failed"}]'
```

The script refuses to record PASS when any command exited non-zero. That refusal
is deliberate: a deterministic failure outranks any judgment that the code is
actually fine.

## 5. Report

On pass, print the command table and the next action.

On failure, print the failing commands and what broke. Do not characterize a
failing run as "mostly passing" — verification is binary here, and everything
downstream depends on that being honest.
