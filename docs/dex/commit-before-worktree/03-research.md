# Codebase Research: commit-before-worktree

> Objective findings about the system as it exists today.
> Produced by isolated workers that never saw the feature request.

## Scope

Questions investigated:

1. How does `guard.mjs` decide whether a Bash command is allowed? (trace of `git commit`)
2. How do `shell.mjs` and `commands.mjs` classify git commands?
3. What makes a change allowed in each phase, where does "has not been unlocked" come from, and in which phases is `git commit` refused?
4. Does the guard treat a command differently by checkout (main, worktree, `git -C`)?
5. What does the worktree skill say about uncommitted changes in the main checkout, and does any script refuse on them?
6. Does the guard already allow any change-type command before implementation is unlocked?
7. Where do the skills or README tell the user to run a command themselves?
8. Which tests cover `git commit`, in which phases and checkouts?
9. What does each refusal tell the user to do next, and does any point to something that would itself be refused?

Questions that could not be answered, and why:

- Q5 (worktree skill and uncommitted changes). The research worker returned no facts and no verification. Nothing in this report establishes what `dex/skills/worktree/SKILL.md` says about uncommitted changes, or whether `record-worktree` refuses on them. See Q5 below.

## Executive Map

- `dex/hooks/hooks.json` wires two hooks. PreToolUse runs `guard.mjs` on edit, shell and MCP tool calls. UserPromptSubmit runs `approve-hook.mjs` on what the user types.
- `dex/scripts/shell.mjs` splits a command line into simple commands (argv plus redirects). It does not classify anything.
- `dex/scripts/commands.mjs` labels each simple command with three independent answers: does it publish, does it change the repo (with paths if known), does it record an approval.
- `dex/scripts/guard.mjs` holds the policy in one pure function, `decide()`. It locates write targets (state folder, artifact folder, repo, outside) and applies gates.
- `dex/scripts/state.mjs` computes gates (`computeGates`), the phase label (`derivePhase`), and the next suggested command (`nextAction`). It also records worktrees (`record-worktree`).
- `dex/scripts/lib.mjs` finds the main checkout root (`findRepoRoot`), loads config, and resolves the active feature.

## Current System Flow

Trace of a Bash `git commit` call:

```text
hooks.json PreToolUse (matcher includes Bash)                  hooks.json:3-14
  -> guard.mjs main: read stdin JSON -> evaluateHookInput()    guard.mjs:502-516
  -> findRepoRoot(cwd), loadConfig, featureByWorktree(cwd)
     else resolveActiveFeature()                               guard.mjs:432-479, lib.mjs:132-156, 776-796
  -> decide() -> toolFacts() -> describeCommand()              guard.mjs:266-272, 192-213
       -> parseCommand() splits on ; && || | newlines          shell.mjs:188-200
       -> gitParts() strips global options incl. -C            commands.mjs:42-67
       -> gitChange('commit') = 'git commit', paths: null      commands.mjs:79-91, 452-456
  -> decide() checks, in order:
       approval call?            -> deny                       guard.mjs:275-281
       write into state folder?  -> deny                       guard.mjs:282-290
       ambiguous / lockdown?     -> lockedDecision() deny      guard.mjs:292-300, 383-394
       no active feature?        -> allow                      guard.mjs:302
       publishes?                -> canPublish gate            guard.mjs:310-327
       canImplement.allowed?     -> allow                      guard.mjs:330
       repoChange(): null paths  -> kind 'command'             guard.mjs:224-235
       -> deny "... has not been unlocked" + Next: nextAction  guard.mjs:356-366, 335-343
  -> emitDeny JSON, or exit 0 to allow                         guard.mjs:482-492
```

## Findings

### Q1: How does `guard.mjs` decide whether a Bash `git commit` is allowed?

Verification: VERIFIED, except one PARTIALLY VERIFIED fact (corrected below) and one CONTRADICTED inference (recorded below).

#### Facts

- FACT: The PreToolUse hook runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs"` for tools matching `Write|Edit|MultiEdit|NotebookEdit|ApplyPatch|Bash|BashOutput|PowerShell|Shell|mcp__.*`. VERIFIED.
  Evidence:
  - `dex/hooks/hooks.json:3-14`
- FACT: As the main module, guard.mjs reads the payload from stdin, calls `evaluateHookInput(payload)`, emits a JSON deny when the result is DENY, and otherwise exits 0 (allow). VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:400-406`
  - `dex/scripts/guard.mjs:502-516`
  - `dex/scripts/guard.mjs:482-492`
- FACT: `evaluateHookInput` resolves the repo root with `findRepoRoot`, loads config, resolves the active feature, then calls `decide()`. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:432-480`
  - `dex/scripts/lib.mjs:132-156`
  - `dex/scripts/lib.mjs:776-796`
- FACT: `decide()` is the single policy function. Bash is a shell tool, so it builds facts with `toolFacts()`. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:50`
  - `dex/scripts/guard.mjs:250-252`
  - `dex/scripts/guard.mjs:266-272`
- FACT: `toolFacts()` runs `describeCommand(command, { cwd })` and records approve, publish, changes (with located targets) and redirect writes. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:192-213`
- FACT: `describeCommand()` splits the line with `parseCommand()` and, for git, finds the subcommand with `gitParts()`. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:409-421`
  - `dex/scripts/commands.mjs:430-431`
  - `dex/scripts/commands.mjs:42-67`
- FACT: `commit` is in `GIT_BUILTINS`, so no git alias lookup runs for it. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:26-37`
  - `dex/scripts/commands.mjs:436-451`
- FACT: For `commit`, `gitPublish` returns null and `gitChange` returns `'git commit'`. The entry becomes `change: { what: 'git commit', paths: null }`. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:78-91`
  - `dex/scripts/commands.mjs:452-456`
- FACT: `toolFacts` turns null paths into `targets: null`, meaning the change has no located files. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:204-209`
- FACT: For a plain `git commit`, `facts.approve` is false and no state-folder write is found, so those two checks pass. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:275-290`
  - `dex/scripts/guard.mjs:218-221`
  - `dex/scripts/commands.mjs:428`
- FACT: With no active feature and no ambiguity or lockdown, `decide()` returns `allow('no active Dex feature; Dex does not gate ordinary work')`. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:274-302`
- FACT: With an active feature, `decide()` computes the phase, skips the publish block (publish is null), and returns `allow('implementation gates satisfied')` when `gates.canImplement.allowed` is true. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:304-330`
- FACT: `canImplement.allowed` is true only when there are no blockers among: questions, design or structure unapproved; plan not complete; worktree not ready; `state.blocked`. VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:294-301`
- FACT: When `canImplement.allowed` is false, `repoChange()` returns `{ kind: 'command', what: 'git commit' }` at once, because `targets` is null. No path location is checked. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:224-235`
- FACT: For `kind === 'command'`, the denial reads "Dex blocked git commit for feature "<slug>" because implementation has not been unlocked." It lists the phase, the blockers, a note that read-only work and artifact-folder writes are allowed, and a `Next:` line from `nextAction()`. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:335-343`
  - `dex/scripts/guard.mjs:356-366`
  - `dex/scripts/state.mjs:347`
- FACT: `git commit -am x && git push` is split into two simple commands by `parseCommand()`. The push part sets `facts.publish = 'git push'`, which the publish block denies. The blocker text "human code review is REQUIRED" comes from `computeGates()` in state.mjs, not from guard.mjs. PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/scripts/shell.mjs:188-200`
  - `dex/scripts/commands.mjs:78-88`
  - `dex/scripts/guard.mjs:310-327`
  - `dex/scripts/state.mjs:176`
  - `dex/scripts/state.mjs:318`

#### Inferences

- INFERENCE (CONTRADICTED as originally stated): The original claim was that a bare `git commit` has only two outcomes. Verification found a third. The corrected statement: a bare `git commit` can end in (a) allow, when no feature is active or `canImplement.allowed` is true; (b) a lockdown deny, "Dex refused git commit because ...", when features are ambiguous, state is unreadable, the active marker is broken, or the guard crashed; (c) the "implementation has not been unlocked" deny, when one feature is clearly active and `canImplement` is not satisfied.
  Based on:
  - `dex/scripts/guard.mjs:292-300`
  - `dex/scripts/guard.mjs:383-394`
  - `dex/scripts/guard.mjs:452-473`
  - `dex/scripts/guard.mjs:516-533`
- INFERENCE (VERIFIED): Every form of `git commit` (`--amend`, `-am`, and so on) is treated the same, because `gitChange` returns `'git commit'` before any flag check.
  Based on:
  - `dex/scripts/commands.mjs:79-82`
  - `dex/scripts/commands.mjs:90-91`

#### Unknowns

- UNKNOWN: All branches of `resolveActiveFeature` and `featureByWorktree` (unreadable state, broken marker, ambiguous features) were not enumerated in full. Reading `dex/scripts/lib.mjs:776-801` and `dex/scripts/guard.mjs:408-479` would settle it.

### Q2: How are git commands classified?

Verification: VERIFIED, except one PARTIALLY VERIFIED fact (corrected below).

#### Facts

- FACT: `shell.mjs` `parseCommand` turns a line into simple commands with argv and redirects. It does no classification. It unwraps `env`, `sudo`, `timeout`, `xargs`, `npx` and similar, and looks inside `$(...)`, backticks, `sh -c` and `eval`. VERIFIED.
  Evidence:
  - `dex/scripts/shell.mjs:1-18`
  - `dex/scripts/shell.mjs:25-58`
  - `dex/scripts/shell.mjs:287-351`
- FACT: `commands.mjs` `describeCommand` labels each command on three axes: publish, change, approve. Git uses the sets `GIT_PUBLISH` and `GIT_CHANGE` plus special cases in `gitChange()`. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:1-15`
  - `dex/scripts/commands.mjs:78-107`
  - `dex/scripts/commands.mjs:397-457`
- FACT: Publishing: `push`, `send-pack`, `send-email`, `request-pull`, and `subtree push`. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:78-88`
- FACT: Changes (in `GIT_CHANGE`): `commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `apply`, `filter-branch`, `reset`, `restore`, `clean`, `rm`, `mv`, `pull`, `read-tree`, `checkout-index`, `update-ref`, `update-index`. All get `paths: null`. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:79-82`
  - `dex/scripts/commands.mjs:90-91`
  - `dex/scripts/commands.mjs:452-456`
- FACT: `git stash` is a change unless its subcommand is `list` or `show`. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:100`
- FACT: `git worktree` is a change only for `remove`, `prune`, `move`. `git worktree add` is neither change nor publish. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:103`
- FACT: `git add` is neither change nor publish. It appears only in `GIT_BUILTINS`, which is used for alias resolution. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:26-37`
  - `dex/scripts/commands.mjs:78-107`
- FACT: `git checkout`/`git switch` are changes, except `checkout -b x` / `switch -c x` with no start point, which return null. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:92-99`
- FACT: `git branch` is a change only with delete/move/force/copy flags. `git tag -d` is a change. `git submodule update|add|deinit|sync` and `git sparse-checkout set|add|init|reapply|disable` are changes. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:101-105`
- FACT: Any other git subcommand (status, log, diff, show, fetch, add, and so on) gets publish null and change null. "Read-only" is the absence of a label, not an explicit allow-list. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:84-107`
- FACT: A command with publish null and change null adds nothing to the publish and change checks. The overall outcome still depends on the earlier checks in `decide()` (approval, state writes, lockdown, no feature). PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/scripts/guard.mjs:192-213`
  - `dex/scripts/guard.mjs:266-333`

#### Inferences

- INFERENCE (VERIFIED): The guard does not gate `git add` or `git worktree add` through git-specific rules. Any restriction on them would have to come from another mechanism.
  Based on:
  - `dex/scripts/commands.mjs:78-107`
  - `dex/scripts/guard.mjs:192-213`
  - `dex/tests/guard.test.mjs:162-172`
- INFERENCE (VERIFIED): Classification is two independent nullable labels (publish, change), not one three-way value.
  Based on:
  - `dex/scripts/commands.mjs:416`
  - `dex/scripts/commands.mjs:452-456`

#### Unknowns

- UNKNOWN: No test runs `git add` through the guard. It appears only as test setup run directly with `execFileSync`. A test calling `guardBash(root, 'git add ...')` would settle it.
- UNKNOWN: `git worktree add` is tested through the guard only in the `plan` phase. A test in other phases would settle it.

### Q3: Phase conditions, source of "has not been unlocked", and phases that refuse `git commit`

Verification: VERIFIED, except one PARTIALLY VERIFIED fact (corrected below).

#### Facts

- FACT: `computeGates()` builds all gate objects and three permissions: `canImplement`, `canPr`, `canPublish`. Each is allowed only when its blocker list is empty ("fail closed"). VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:228-338`
- FACT: `canImplement` needs questions, design and structure approved, plan complete, worktree ready, and no drift block. The worktree check is skipped when `config.requireWorktree` is false. VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:252-255`
  - `dex/scripts/state.mjs:290-301`
- FACT: `requireWorktree` defaults to true. VERIFIED.
  Evidence:
  - `dex/scripts/lib.mjs:61-71`
- FACT: `derivePhase()` picks the first match in this order: complete, pr, review, verify, implement, worktree, plan, structure, design, research, questions, initialized. VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:464-478`
- FACT: `canImplement.allowed` is false in every phase from `initialized` through `worktree`, and true from `implement` on unless a new blocker appears. VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:290-301`
  - `dex/scripts/state.mjs:464-478`
- FACT: `derivePhase()` ignores `state.blocked`. A drift-blocked feature can be labelled `implement` or later while `canImplement` is false. VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:300`
  - `dex/scripts/state.mjs:464-478`
- FACT: `decide()` order: approval call denied; state-folder write denied; ambiguity or lockdown denied via `lockedDecision()`; no feature allowed; publish allowed only with `canPublish`; other changes allowed only with `canImplement`. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:266-377`
- FACT: The phrase "has not been unlocked" appears in source code once, in the `kind === 'command'` branch reached only when `canImplement.allowed` is false. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:330`
  - `dex/scripts/guard.mjs:356-366`
- FACT: `repoChange()` returns a `'command'` change for any entry with null targets, without checking where anything lands. Location checks apply only to changes with known paths. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:224-235`
- FACT: Once a feature is resolved, `git commit`'s outcome depends only on `canImplement.allowed`, not on where its paths land. But the working directory can still change which feature's gates apply, through `featureByWorktree()`, when several features or worktrees exist. PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/scripts/commands.mjs:90-91`
  - `dex/scripts/guard.mjs:204-213`
  - `dex/scripts/guard.mjs:224-235`
  - `dex/scripts/guard.mjs:329-366`
  - `dex/scripts/guard.mjs:408-420`
  - `dex/scripts/guard.mjs:462-465`
- FACT: A test at the `design` stage (design written, not yet approved) expects `git commit -am "wip"`, `git commit --amend`, and `cd /tmp; git commit -am x` to be denied. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:178-210`
  - `dex/tests/helpers.mjs:115-141`
- FACT: A test at the `worktree` helper stage (worktree created and recorded) asserts `canImplement.allowed` is true and expects `git commit -am "S1 tracer"` from the main checkout to be allowed. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:49-51`
  - `dex/tests/guard.test.mjs:238-253`
  - `dex/tests/helpers.mjs:115-143`
- FACT: The approve-code text says staging and committing do not void a recorded human code approval. Only further production changes do. VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:766-768`
- FACT: In lockdown, `lockedDecision()` denies a `git commit` with a different message built from the lockdown reason. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:294-300`
  - `dex/scripts/guard.mjs:383-394`
- FACT: With no active feature, the guard never gates `git commit`. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:302`

#### Inferences

- INFERENCE (VERIFIED): With one clearly active feature and default config, `git commit` in the main checkout is refused in phases `initialized`, `questions`, `research`, `design`, `structure`, `plan` and `worktree`.
  Based on:
  - `dex/scripts/state.mjs:290-301`
  - `dex/scripts/state.mjs:464-478`
  - `dex/scripts/guard.mjs:329-366`
  - `dex/tests/guard.test.mjs:178-210`
- INFERENCE (VERIFIED): `git commit` is allowed from `implement` through `complete`, unless drift sets `state.blocked`, which re-locks it while the phase label stays the same.
  Based on:
  - `dex/scripts/state.mjs:290-301`
  - `dex/scripts/guard.mjs:329-330`
  - `dex/tests/guard.test.mjs:238-253`
  - `dex/tests/guard.test.mjs:267-270`
- INFERENCE (VERIFIED): The header's rule that "a path is judged by where it really lands" does not apply to `git commit`. Its refusal depends on phase only.
  Based on:
  - `dex/scripts/guard.mjs:19-31`
  - `dex/scripts/commands.mjs:452-456`
  - `dex/scripts/guard.mjs:224-235`

#### Unknowns

- UNKNOWN: Whether anything other than guard.mjs intercepts `git commit`, for example a git commit hook. Reading `dex/scripts/pre-push.mjs` and any hook-install step (for example in `doctor.mjs`) would settle it.
- UNKNOWN: Whether `config.strictGates` changes `canImplement`. Reading every reference to it (`state.mjs:717,783,790,907` and lib.mjs) would settle it.

### Q4: Does the checkout a command runs in matter?

Verification: VERIFIED.

#### Facts

- FACT: `findRepoRoot` runs `git rev-parse --show-toplevel` and `--git-common-dir` from the caller's cwd and returns the parent of the shared `.git`. A worktree and the main checkout share one common git dir, so both resolve to the main checkout root. VERIFIED.
  Evidence:
  - `dex/scripts/lib.mjs:124-156`
  - `dex/scripts/guard.mjs:432-436`
- FACT: `locate()` classifies each write target against "bases": each recorded feature worktree (`main: false`) and the main checkout (`main: true`). Only a path under a `main: true` base can be classified as the state folder. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:127-154`
- FACT: `gitParts()` skips `-C`, `--git-dir`, `--work-tree` and their values only to find the subcommand. The value is never used. `describeCommand()` changes its notion of current directory only on `cd` or `pushd`. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:39-67`
  - `dex/scripts/commands.mjs:409-458`
- FACT: Every git change carries `paths: null`, so the directory a `git -C <path>` targets never affects whether it is blocked. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:79-107`
  - `dex/scripts/commands.mjs:452-456`
  - `dex/scripts/guard.mjs:227-231`
- FACT: Feature ownership is decided by `featureByWorktree()` (the tool call's cwd plus edit-tool targets, matched against recorded worktree paths), falling back to `resolveActiveFeature()` (the `.dex/active` marker or the single active feature). Shell command text is never inspected for this. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:161-182`
  - `dex/scripts/guard.mjs:408-420`
  - `dex/scripts/guard.mjs:432-479`
  - `dex/scripts/lib.mjs:776-796`
- FACT: The publish and code-review gate is evaluated on `featureDir(root, state)`: the recorded worktree if it exists on disk, otherwise the main checkout root. VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:164-167`
- FACT: Tests expect `git -C <worktree> push` from the main checkout and `git push` from the worktree to get the same decision, both before approval (deny) and after (allow). VERIFIED.
  Evidence:
  - `dex/tests/e2e.test.mjs:80-104`
  - `dex/tests/gates.test.mjs:94-102`
- FACT: `git -C <path>` and `git -C .` forms appear in the guard test tables and must behave like the plain form. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:290-299`
  - `dex/tests/shell-guard.test.mjs:107-114`
  - `dex/tests/shell-guard.test.mjs:155-160`
- FACT: `record-worktree` in state.mjs runs `git worktree list --porcelain`, treats entry 0 as the main checkout, and refuses to record it as a feature worktree. VERIFIED.
  Evidence:
  - `dex/scripts/state.mjs:1242-1256`
  - `dex/scripts/state.mjs:1267-1273`
  - `dex/scripts/state.mjs:1294-1307`

#### Inferences

- INFERENCE (VERIFIED): The checkout matters only for classifying a file path (state folder exists only in the main checkout). A `-C` argument never matters.
  Based on:
  - `dex/scripts/guard.mjs:127-154`
  - `dex/scripts/commands.mjs:39-67`
- INFERENCE (VERIFIED): Neither `-C` nor an inline `cd` can make the guard apply a different feature's gates than the tool call's real cwd or the active marker implies.
  Based on:
  - `dex/scripts/guard.mjs:408-479`
  - `dex/scripts/lib.mjs:776-796`

#### Unknowns

- UNKNOWN: Whether non-git tools with their own directory flags get the same treatment. Reading how `FILE_OPS` handles such flags would settle it.
- UNKNOWN: The meaning of the comment at `dex/tests/e2e.test.mjs:85`. See Contradictions. Its git history would settle it.

### Q5: Worktree skill and uncommitted changes in the main checkout

Verification: UNVERIFIED. The research worker returned no facts, inferences or verification for this question.

#### Facts

- None established.

#### Unknowns

- UNKNOWN: What `dex/skills/worktree/SKILL.md` tells the model to do when the main checkout has uncommitted changes, and the reason it gives. Reading that file would settle it.
- UNKNOWN: Whether any script in `dex/scripts/` (for example `record-worktree`, `state.mjs:1242-1307`) refuses on uncommitted changes. Q4 established only that `record-worktree` refuses to record the main checkout itself. Reading `record-worktree` and `checkWorktree` in full would settle it.

### Q6: Changes already allowed before implementation is unlocked

Verification: VERIFIED, except one PARTIALLY VERIFIED fact (corrected below).

#### Facts

- FACT: Default `artifactRoot` is `docs/dex`. Default `stateRoot` is `.dex`. VERIFIED.
  Evidence:
  - `dex/scripts/lib.mjs:61-71`
- FACT: Each write target is classified as `state` (under `stateRoot`, or always `.dex` in the main checkout), `artifact` (under `artifactRoot`), `repo`, `outside` or `unknown`. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:119-154`
- FACT: The implementation gate only counts `repo` and `unknown` locations (`inRepo()`). Artifact and state locations never trigger it. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:215`
  - `dex/scripts/guard.mjs:224-235`
  - `dex/scripts/guard.mjs:329-333`
- FACT: The file header names artifact-folder writes as "the exception" to the implementation gate. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:12-17`
- FACT: The edit denial says writes to `<artifactRoot>/**` and `<stateRoot>/**` are allowed now. The shell-command denial mentions only `<artifactRoot>/`. The redirect denial mentions both. PARTIALLY VERIFIED (corrected statement, with the redirect branch from the verifier's missed context).
  Evidence:
  - `dex/scripts/guard.mjs:345-354`
  - `dex/scripts/guard.mjs:356-365`
  - `dex/scripts/guard.mjs:367-376`
- FACT: Any direct tool or shell write into the state folder is denied, even with no active feature, because the check runs before the no-feature allow. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:274-290`
- FACT: `describeCommand` recognises `state.mjs approve` only. Other `node .../state.mjs <subcommand>` calls (for example `set-slices`) get `change: null`. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:226`
  - `dex/scripts/commands.mjs:409-430`
- FACT: Such calls therefore produce no change and are allowed in every locked phase via "no repository change detected". VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:224-235`
  - `dex/scripts/guard.mjs:332-333`
- FACT: A test lists `node /opt/dex/scripts/state.mjs set-slices feat ...` as harmless and expects it allowed during design. VERIFIED.
  Evidence:
  - `dex/tests/shell-guard.test.mjs:177-192`
- FACT: Tests expect Write to `docs/dex/**` allowed and Write to `.dex/**` denied during design, including Windows-style paths. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:94-124`
- FACT: Tests expect shell file operations (heredoc, cp, mv, rm, mkdir, touch) into `docs/dex/**` allowed during design. VERIFIED.
  Evidence:
  - `dex/tests/shell-guard.test.mjs:177-192`
- FACT: Branch and worktree creation at the current commit (`git worktree add`, `git branch`, `git switch -c`, `git checkout -b`) are not changes and are allowed; a `plan`-stage test confirms it. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:90-107`
  - `dex/tests/guard.test.mjs:162-172`
- FACT: The publish gate is a separate check that runs in every phase once a feature is resolved. It is not an exception to the implementation lock. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:309-327`

#### Inferences

- INFERENCE (VERIFIED): The state.mjs exception is not an explicit allow rule. It exists because `describeCommand` knows a fixed list of changing programs, and `node <script>` is not on it.
  Based on:
  - `dex/scripts/commands.mjs:409-496`
  - `dex/scripts/guard.mjs:224-235`
- INFERENCE (VERIFIED): The artifact-folder exception is deliberate: it is expressed through `classify()` and the `inRepo()` filter, and documented in the header.
  Based on:
  - `dex/scripts/guard.mjs:12-17`
  - `dex/scripts/guard.mjs:119-154`
  - `dex/scripts/guard.mjs:215`
- INFERENCE (VERIFIED): The state-folder rule is a stricter always-on deny for direct writes. State changes only through state.mjs run as a program, which the change detector does not see (except `approve`).
  Based on:
  - `dex/scripts/guard.mjs:274-290`
  - `dex/scripts/commands.mjs:226`
  - `dex/scripts/commands.mjs:428`

#### Unknowns

- UNKNOWN: Whether state.mjs subcommands other than `set-slices` are tested through the guard in a locked phase. A grep of tests for `state.mjs <subcommand>` passed to `guardBash`/`decide` would settle it.
- UNKNOWN: Whether leaving `node .../state.mjs` unrecognised is intended or a gap. No design note was found.

### Q7: Where Dex tells the user to run a command themselves

Verification: VERIFIED, except two PARTIALLY VERIFIED items (corrected below).

#### Facts

- FACT: The README offers `node <dex>/scripts/state.mjs approve <gate> <slug>` "in your own terminal" as a backup for approvals. VERIFIED.
  Evidence:
  - `dex/README.md:300-305`
- FACT: The README says users can run `scripts/state.mjs` themselves: "You can run it yourself from the repository". VERIFIED.
  Evidence:
  - `dex/README.md:444-454`
- FACT: The approve skill says: if there is no hook message and the gate is not approved, ask the user to run the approve command "in their own terminal". VERIFIED.
  Evidence:
  - `dex/skills/approve/SKILL.md:32-37`
- FACT: The approve skill bars the model from recording an approval itself or through another mechanism. Only for the code gate does it say typing `/dex:approve code` is the user's confirmation that they read the diff. PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/skills/approve/SKILL.md:17-18`
  - `dex/skills/approve/SKILL.md:41-45`
  - `dex/skills/approve/SKILL.md:48-51`
- FACT: The pr skill says: without `gh`, print the body and the exact command for the user to run, and do not invent another publishing mechanism. VERIFIED.
  Evidence:
  - `dex/skills/pr/SKILL.md:67-74`
- FACT: The worktree skill says: if pre-push hook install is refused (existing hook or `core.hooksPath`), show the user the printed line and let them add it. Do not edit their hook. VERIFIED.
  Evidence:
  - `dex/skills/worktree/SKILL.md:79-84`
- FACT: The worktree skill says, for cleanup: "describe the command and let the user run it". (From the verifier's missed context.)
  Evidence:
  - `dex/skills/worktree/SKILL.md:100`
- FACT: The guard's approval refusal also tells the user to "run the approve command in their own terminal". (From the verifier's missed context.)
  Evidence:
  - `dex/scripts/guard.mjs:279`
- FACT: No `! <command>` syntax appears in `dex/README.md` or `dex/skills/`. VERIFIED.
  Evidence:
  - `dex/README.md` (grep for `^!`, no match)
  - `dex/skills/*/SKILL.md` (grep for `^!`, no match)
- FACT: The manual test log records a tester running the approve command and `git push` in their own terminal. VERIFIED.
  Evidence:
  - `dex/tests/LIVE-CHECKS.md:45`
  - `dex/tests/LIVE-CHECKS.md:59`

#### Inferences

- INFERENCE (PARTIALLY VERIFIED, corrected): "Run it yourself" wording appears in two situations: (a) a backup when automation did not run or is unavailable (approve, PR without `gh`, refused hook install); (b) destructive actions Dex will not do itself (worktree and branch cleanup).
  Based on:
  - `dex/README.md:300-305`
  - `dex/skills/approve/SKILL.md:32-37`
  - `dex/skills/worktree/SKILL.md:81-84`
  - `dex/skills/worktree/SKILL.md:100`
  - `dex/skills/pr/SKILL.md:73-74`

#### Unknowns

- UNKNOWN: Whether `! <command>` is used anywhere outside the README and skills. A repo-wide grep would settle it.

### Q8: Tests that cover `git commit`

Verification: VERIFIED, except two PARTIALLY VERIFIED items (corrected below).

#### Facts

- FACT: "repository mutations during design are DENIED" expects `git commit -am "wip"`, `git commit --amend` and `cd /tmp; git commit -am x` denied at `design`. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:178-210`
- FACT: The `verdict()` helper calls `decide()` without `cwd`, so cwd defaults to the main checkout root. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:49-51`
  - `dex/scripts/guard.mjs:266`
- FACT: "source edits during implementation are ALLOWED" expects `git commit -am "S1 tracer"` allowed at `worktree`. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:238-253`
- FACT: "push and PR creation are DENIED before human code approval" expects `git commit -am x && git push` denied, with the human-code-review message. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:281-305`
- FACT: "with no active Dex feature, nothing is gated" expects `git commit -am x` allowed. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:344-349`
- FACT: The push-allowed test commits in the worktree with `execFileSync` as setup. The commit is not judged by the guard. VERIFIED.
  Evidence:
  - `dex/tests/guard.test.mjs:307-318`
- FACT: shell-guard "finding 27" runs `git --no-pager commit -m x` through the real guard process at `design` and expects deny. VERIFIED.
  Evidence:
  - `dex/tests/shell-guard.test.mjs:79-84`
  - `dex/tests/shell-guard.test.mjs:155-171`
  - `dex/tests/helpers.mjs:166-197`
- FACT: `afterApproval()` and the pre-push hook tests commit in the worktree directly as setup. `beforeApproval()` does not commit. No commit in these tests is judged by the guard. PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/tests/shell-guard.test.mjs:86-101`
  - `dex/tests/shell-guard.test.mjs:304-317`
  - `dex/tests/helpers.mjs:146-155`
- FACT: `advanceTo()` steps are: init, questions, questions-approved, research, design, design-approved, structure, structure-approved, slices, plan, worktree. The `worktree` step runs `git worktree add` to `<root>-wt` on branch `dex/<slug>`. VERIFIED.
  Evidence:
  - `dex/tests/helpers.mjs:115-143`

#### Inferences

- INFERENCE (PARTIALLY VERIFIED, corrected): A literal `git commit` is judged by the guard in two phases: `design` (denied, both files) and `worktree` before implementation completes (allowed). After implementation completes, only the compound `git commit -am x && git push` is judged (denied). With no feature at all, a bare `git commit` is allowed.
  Based on:
  - `dex/tests/guard.test.mjs:178-210`
  - `dex/tests/guard.test.mjs:238-253`
  - `dex/tests/guard.test.mjs:281-305`
  - `dex/tests/guard.test.mjs:344-349`
  - `dex/tests/shell-guard.test.mjs:155-171`
- INFERENCE (VERIFIED): guard.test.mjs never judges a `git commit` with cwd set to the feature worktree.
  Based on:
  - `dex/tests/guard.test.mjs:49-51`
  - `dex/scripts/guard.mjs:266`

#### Unknowns

- UNKNOWN: No test in either file judges `git commit` with cwd in a feature worktree. None was found.
- UNKNOWN: No test judges `git commit` in the `plan`, `structure`, `questions` or `research` phases.

### Q9: What refusals tell the user to do next

Verification: VERIFIED, except four PARTIALLY VERIFIED items (corrected below).

#### Facts

- FACT: guard.mjs has five kinds of refusal: approval from a tool call; state-folder write; ambiguity or lockdown; publish before publish gates; repository change before implementation gates (edit, shell command or redirect). VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:274-394`
- FACT: Approval refusal: type `/dex:approve <gate> <slug>` or run the approve command in your own terminal. "Do not try another way." VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:275-280`
- FACT: State-write refusal: use the matching `/dex:*` command; run `/dex:status` if state looks wrong. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:283-289`
- FACT: Ambiguous-feature refusal: run `/dex:resume <feature>`. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:294-300`
- FACT: Lockdown refusal: "Run /dex:doctor or /dex:status, and tell the user what is wrong". Reading and inspecting stay allowed. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:383-394`
  - `dex/scripts/guard.mjs:443-459`
  - `dex/scripts/guard.mjs:467-473`
  - `dex/scripts/guard.mjs:516-533`
- FACT: Publish refusal always ends with `/dex:status <slug>`. It adds `node .../status.mjs <slug> --review` then `/dex:approve code <slug>` only when the human code-review gate is unmet. PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/scripts/guard.mjs:310-327`
- FACT: All pre-implementation change refusals end with `Next:` from `nextAction()`, or `/dex:status <slug>` if it throws. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:336-376`
- FACT: When the guard calls it, `nextAction()` returns `/dex:approve <gate> <slug>` or a pre-implementation skill: `/dex:start`, `/dex:questions`, `/dex:research`, `/dex:design`, `/dex:structure`, `/dex:plan` or `/dex:worktree`. PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/scripts/state.mjs:294-301`
  - `dex/scripts/state.mjs:347-417`
  - `dex/scripts/guard.mjs:329-343`
- FACT: Approvals are recorded by a separate UserPromptSubmit hook (`approve-hook.mjs`) that calls state.mjs's `run(['approve', ...])` directly. guard.mjs never sees it. VERIFIED.
  Evidence:
  - `dex/scripts/approve-hook.mjs:1-45`
  - `dex/hooks/hooks.json:2-27`
- FACT: The approve skill cannot record an approval. It runs only read-only commands: `node state.mjs status <slug>` and `node status.mjs <slug> --review`. PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/skills/approve/SKILL.md:9-46`
- FACT: `node .../state.mjs status|check|active`, `status.mjs` and `doctor.mjs` get no approve, change or write label. VERIFIED.
  Evidence:
  - `dex/scripts/commands.mjs:253-391`
  - `dex/scripts/commands.mjs:409-496`
  - `dex/scripts/commands.mjs:428`
- FACT: `decide()` allows those commands in every branch, including lockdown. VERIFIED.
  Evidence:
  - `dex/scripts/guard.mjs:274-394`
- FACT: The README says the model cannot run the approve command itself and offers the user's own terminal as a backup. VERIFIED.
  Evidence:
  - `dex/README.md:300-305`
- FACT: guard.test.mjs states read-only work is never refused. The test that checks a broad read-only list runs only at `design`. PARTIALLY VERIFIED (corrected statement).
  Evidence:
  - `dex/tests/guard.test.mjs:5-9`
  - `dex/tests/guard.test.mjs:138-172`
- FACT: The `/dex:resume` skill runs `state.mjs check <slug>` and `state.mjs active <slug>`. The latter writes `.dex/active`, but is not labelled a change, so it is allowed. (From the verifier's missed context.)
  Evidence:
  - `dex/skills/resume/SKILL.md:17-22`

#### Inferences

- INFERENCE (PARTIALLY VERIFIED, corrected): No refusal points to a command the guard would itself refuse in the same state. This holds for two reasons: status/check/active/doctor calls are never labelled as changes; and `/dex:worktree`'s git commands are not labelled as changes by `commands.mjs`'s git rules (not because they are artifact writes).
  Based on:
  - `dex/scripts/guard.mjs:274-394`
  - `dex/scripts/commands.mjs:409-496`
  - `dex/scripts/state.mjs:347-417`
  - `dex/skills/resume/SKILL.md:17-22`

#### Unknowns

- UNKNOWN: Whether other skills (worktree, implement, verify, pr, plan, and so on) call write-type state.mjs subcommands through Bash, and whether the guard sees them. Reading each skill and checking against `commands.mjs` would settle it.
- UNKNOWN: Q9 did not check whether a skill named in `Next:` runs a git change command (such as `git commit`) in its own steps. The verified conclusion covers the commands named in the messages, not every command inside those skills.

## Existing Patterns

### Pattern: Git subcommands classified by explicit sets plus flag rules

Where it appears:
- `dex/scripts/commands.mjs:26-107`

What it does: `GIT_PUBLISH` and `GIT_CHANGE` name subcommands. `gitChange()` adds flag-based rules (checkout/switch branch creation, stash list/show, branch/tag flags, worktree remove/prune/move, submodule, sparse-checkout). Anything unnamed is unlabelled.

Where it is NOT used: non-git programs are matched partly by regex over the joined command text (`TEXT_CHANGES`, `commands.mjs:363-391`).

### Pattern: Exception by location

Where it appears:
- `dex/scripts/guard.mjs:119-154`, `215`, `224-235`

What it does: write targets with known paths are classified by where they land. Artifact-folder writes pass the implementation gate. State-folder writes are always denied.

Where it is NOT used: changes with null paths, which include every git change such as `git commit` (`guard.mjs:227-228`).

### Pattern: Exception by classifying a command as "not a change"

Where it appears:
- `dex/scripts/commands.mjs:92-99`, `103` (branch and worktree creation)
- `dex/tests/guard.test.mjs:162-172` (test label: "a prerequisite stage, not implementation")

What it does: a command that would otherwise be gated is let through by returning null from `gitChange()`, not by an allow rule in `decide()`.

Where it is NOT used: `decide()` itself has no per-phase or per-command allow list.

### Pattern: Exception by omission

Where it appears:
- `dex/scripts/commands.mjs:409-496` (no rule for `node <script>`)
- `dex/tests/shell-guard.test.mjs:177-192` (`state.mjs set-slices` listed as harmless)

What it does: state.mjs subcommands other than `approve` are allowed because nothing labels them.

Where it is NOT used: `state.mjs approve` is matched explicitly and refused (`commands.mjs:428`).

### Pattern: Two refusal families with different wording

Where it appears:
- Gate refusals with a `Next:` footer from `nextAction()`: `dex/scripts/guard.mjs:335-376`
- Lockdown refusals pointing to `/dex:doctor` or `/dex:status`: `dex/scripts/guard.mjs:383-394`

### Pattern: Telling the user to run a command themselves

Where it appears:
- `dex/README.md:300-305`, `dex/skills/approve/SKILL.md:32-37`, `dex/skills/pr/SKILL.md:73-74`, `dex/skills/worktree/SKILL.md:81-84`, `dex/skills/worktree/SKILL.md:100`, `dex/scripts/guard.mjs:279`

What it does: prose such as "in your own terminal" or "let the user run it".

Where it is NOT used: no `! <command>` form was found in the README or skills.

## Relevant Tests

- `dex/tests/guard.test.mjs:178-210` — `git commit` variants denied at `design`.
- `dex/tests/guard.test.mjs:238-253` — `git commit` allowed at `worktree` once `canImplement` is true; cwd is the main checkout.
- `dex/tests/guard.test.mjs:281-305` — `git commit ... && git push` denied before human code approval.
- `dex/tests/guard.test.mjs:344-349` — `git commit` allowed with no active feature.
- `dex/tests/guard.test.mjs:162-172` — `git worktree add`, `git branch`, `git switch -c`, `git checkout -b` allowed at `plan`.
- `dex/tests/guard.test.mjs:138-159` — read-only git commands allowed at `design`.
- `dex/tests/guard.test.mjs:94-124` — artifact writes allowed, state writes denied, at `design`.
- `dex/tests/shell-guard.test.mjs:155-171` — change commands, including `git --no-pager commit`, denied at `design` through the real hook process.
- `dex/tests/shell-guard.test.mjs:177-192` — harmless commands, including artifact file ops and `state.mjs set-slices`, allowed at `design`.
- `dex/tests/shell-guard.test.mjs:107-149` — publish forms denied before approval, allowed after; mere mentions of "push" allowed.
- `dex/tests/e2e.test.mjs:80-104` — `git -C <wt> push` from main checkout and `git push` from worktree get the same decision.
- `dex/tests/helpers.mjs:115-197` — `advanceTo()` phase steps and `guardBash()` real-process runner.

Gaps: no test judges `git commit` with cwd in a feature worktree, or in phases other than `design` and `worktree`. No test judges `git add` through the guard.

## Relevant Configuration

- `dex/hooks/hooks.json` — wires PreToolUse to `guard.mjs` and UserPromptSubmit to `approve-hook.mjs`.
- `dex/scripts/lib.mjs:61-71` (`DEFAULT_CONFIG`) — `artifactRoot: 'docs/dex'`, `stateRoot: '.dex'`, `requireWorktree: true`. With `requireWorktree: false`, the worktree gate is skipped (`state.mjs:252-255`), which changes which phases block `canImplement`.
- `config.strictGates` — referenced at `state.mjs:717,783,790,907`. Its effect on `canImplement` is unknown.

## Relevant Dependencies

- None beyond Node built-ins. There is no `package.json` under `dex/`. Scripts use `child_process` (`execFileSync`, `spawnSync`) to call `git` (`commands.mjs` alias lookup, `lib.mjs` `findRepoRoot`, `state.mjs` `listWorktrees`).

## Contradictions / Ambiguities

- **Location-aware rule vs git changes.** The guard.mjs header says a path is judged by where it really lands (`guard.mjs:19-31`). Every git change, including `git commit`, carries null paths and is judged by phase only (`commands.mjs:452-456`, `guard.mjs:224-235`). A commit in a feature worktree and one in the main checkout get the same answer once the feature is resolved.
- **"Parsed, not pattern-matched" vs regex matching.** The header says shell commands are parsed, not pattern-matched (`guard.mjs:22-24`). Git follows this. Non-git changes are partly matched by regex over the command text (`commands.mjs:363-391`).
- **Three ways to express an exception.** Artifact writes pass by location (`guard.mjs:215`). Branch and worktree creation pass by returning "not a change" from `gitChange()` (`commands.mjs:92-103`). state.mjs subcommands pass by not being recognised at all (`commands.mjs:409-496`). There is no explicit allow rule in `decide()`.
- **Header names one exception; code has more.** The header names only artifact-folder writes as the exception to the implementation gate (`guard.mjs:12-17`). The code also lets through branch/worktree creation and state.mjs subcommands.
- **State folder: blocked one way, open another.** Direct Write/Edit or shell writes to `.dex/**` are always denied (`guard.mjs:282-290`). `node .../state.mjs <subcommand>` changes the same folder and is allowed in every phase (`shell-guard.test.mjs:177-192`, `skills/resume/SKILL.md:17-22`).
- **Refusal messages disagree on what is allowed.** The edit and redirect denials say `<stateRoot>/**` writes are allowed now (`guard.mjs:345-354`, `367-376`). The shell-command denial names only `<artifactRoot>/` (`guard.mjs:356-365`). Separately, direct writes to the state folder are always denied (`guard.mjs:282-290`).
- **Phase label vs gate.** `derivePhase()` ignores `state.blocked` (`state.mjs:464-478`), so a feature can show phase `implement` while `git commit` is refused.
- **Two refusal texts for the same commit.** A `git commit` may be refused as "has not been unlocked" (`guard.mjs:356-366`) or as "Dex refused git commit because ..." in lockdown (`guard.mjs:383-394`), with different next steps.
- **Test comment vs assertions.** `dex/tests/e2e.test.mjs:85` says "From the main checkout this is already denied; from the worktree it is not." Both assertions below it expect `deny`.
- **Staging and committing are ungated in different ways.** `git add` is unlabelled and so ungated (`commands.mjs:78-107`). `git commit` is a gated change. The approve-code text says staging and committing do not void a code approval (`state.mjs:766-768`).
- **Cwd does and does not matter.** Once a feature is resolved, cwd does not affect `git commit`. But cwd chooses which feature's gates apply through `featureByWorktree()` (`guard.mjs:408-420`, `462-465`), while a `-C` or inline `cd` does not (`commands.mjs:39-67`).

## Research Confidence

High-confidence areas:

- The full `git commit` decision path in guard.mjs, commands.mjs and shell.mjs (Q1, Q2, Q3).
- How `-C`, cwd and worktrees affect decisions (Q4).
- Existing exceptions to the implementation gate and how tests pin them (Q6).
- Refusal wording and what each points to (Q9).
- Which tests cover `git commit` (Q8).

Low-confidence areas:

- Q5 is unanswered. What the worktree skill says about uncommitted changes, and whether any script refuses on them, is unknown.
- All branches of active-feature resolution (`lib.mjs:776-801`, `guard.mjs:408-479`) were not enumerated.
- The effect of `config.strictGates` on `canImplement`.
- Whether any git hook other than pre-push intercepts `git commit`.
- Whether skills named in refusal `Next:` lines run gated commands inside their own steps.
- The intent behind leaving `node .../state.mjs` unrecognised, and behind the `e2e.test.mjs:85` comment.

## Files Most Relevant to Design

- `dex/scripts/guard.mjs`
- `dex/scripts/commands.mjs`
- `dex/scripts/state.mjs` (`computeGates`, `derivePhase`, `nextAction`, `record-worktree`)
- `dex/scripts/shell.mjs`
- `dex/scripts/lib.mjs` (`DEFAULT_CONFIG`, `findRepoRoot`, `resolveActiveFeature`)
- `dex/skills/worktree/SKILL.md`
- `dex/tests/guard.test.mjs`
- `dex/tests/shell-guard.test.mjs`
- `dex/tests/helpers.mjs`
