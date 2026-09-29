**AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW.**

This report is supplemental evidence. It records no approval. A human must read the production diff and run `/dex:approve code commit-before-worktree`.

## Scope

- **What was reviewed:** the change that lets a user commit pending work before `/dex:worktree` creates a worktree. This covers the worktree skill's printed commit command, the guard's refusal hint for `git commit`, and their tests.
- **Base:** `e5fad4a0206a87d70090bff124ec1984ece02f7f`
- **Reviewed tree:** `5eb244fe3c426578f1e38eef69a62466106a0000`
- **Dimensions run:** correctness, design-conformance, test-adequacy.
- **Dimensions not run:** none. All requested dimensions ran.

## Verification Evidence

Overall status: **PASS** (run at 2026-09-29T00:21:03.520Z).

| Command | Category | Exit code | Result |
|---|---|---|---|
| `node --test dex/tests/*.test.mjs` | unit | 0 | 303 pass, 0 fail, 0 skipped |
| `node dex/scripts/doctor.mjs` | static-analysis | 0 | Ready |

## Findings

### BLOCKER

None.

### HIGH

None.

### MEDIUM

None.

### LOW

#### 1. Non-ASCII file names are not tested, and the test helper cannot read them

- **Severity:** LOW
- **File:** `dex/tests/repo-root.test.mjs`
- **Line / symbol:** line 229, `porcelainPaths`
- **Claim:** The quoted-name test only uses `new file.txt`. Git quotes that name but does not escape it. Git writes non-ASCII names with octal escapes, so `café.md` appears as `"caf\303\251.md"`. That form is never tested. The helper un-quotes names with `JSON.parse`, which throws on it.
- **Evidence:** `porcelainPaths` (line 230) un-quotes with `JSON.parse`. The only quoted name used is `new file.txt` (lines 244-247). `JSON.parse` on `"caf\303\251.md"` throws "Bad escaped character in JSON". The skill (SKILL.md step 2) tells Claude to "undo its escapes", but no test checks that an escaped name ends up in the commit.
- **Failure scenario:** A user has an untracked file `café.md` and picks "Commit them first". If Claude copies git's escaped name into the command, `git add -- 'caf\303\251.md'` fails with "pathspec did not match". The `&&` chain stops and nothing is committed. If the skill's un-escaping instruction were reworded or removed, no test would notice.
- **Impact:** It fails safely: nothing is committed or lost. But the user gets a confusing git error at the exact step this change unblocks. The tests also suggest escaped names are covered when they are not.
- **Recommended correction:** Add a non-ASCII untracked file such as `café.md` to the quoted-name test. Read names with `git status --porcelain -z`, or decode git's quoting including octal bytes as UTF-8. Assert that the file lands in the commit.
- **Confidence:** high
- **Dimension:** test-adequacy

#### 2. The approved design still shows the older commit command

- **Severity:** LOW
- **File:** `dex/skills/worktree/SKILL.md`
- **Line / symbol:** line 44, worktree skill step 2, "Commit them first"
- **Claim:** The command the skill prints differs from the command in the approved design and structure documents. Those documents still show the older, simpler command.
- **Evidence:** `04-design.md` lines 60 and 76 give `! git commit -m "<message>" -- <paths>`. SKILL.md line 44 prints `! cd "$(git rev-parse --show-toplevel)" && git add -- '<new path>' && git commit -m '<message>' -- '<path>' ...`. The implementation log says the human agreed to each change during review rounds. It also says the design documents were left alone on purpose so their approvals would not reset.
- **Failure scenario:** Someone later edits the skill using the approved design as the source and "fixes" it back to the simpler command. That brings back two failures. `git commit -- <path>` refuses untracked files. The command also breaks when the session starts in a subfolder.
- **Impact:** Documentation gap only. What shipped is what the human agreed to, but the only record of it is the implementation log.
- **Recommended correction:** No code change. When the feature is closed, add a note to `04-design.md` and `05-structure.md` pointing to the final command recorded in the implementation log.
- **Confidence:** high
- **Dimension:** design-conformance

## Design Conformance

**Conforms: yes.** The known divergences are below. None changes what the guard allows or refuses.

- **The printed commit command grew.** The approved form was `! git commit -m "<msg>" -- <paths>`. It is now `! cd "$(git rev-parse --show-toplevel)" && git add -- '<untracked>' && git commit -m '<msg>' -- '<paths>'`. The human agreed to this during review, and the implementation log records it. `04-design.md` and `05-structure.md` were not updated (see LOW finding 2).
- **The guard's refusal adds a paragraph, not one line.** The design describes a single line. The shipped hint is text plus a blank line. It is keyed on `change.what === 'git commit'`, as the structure specified.
- **The guard tests run in a different state than planned.** They run in the plan state, where `/dex:worktree` comes next. The structure planned the worktree and design phases. The tests also cover `--amend`, the `-C` form, and a chained `git add && git commit`.
- **A known gap was left open on purpose.** In a chained command where the commit is not the first refused step, the hint does not appear.

## Test Assessment

The tests pin down the parts that matter most.

- **Guard tests** check that refused commits carry the new hint. This covers plain commits, `--amend`, the `-C` form, and a commit chained after `git add`. They also check that other refusals do not carry it. No allow or refuse decision changed.
- **Repo-root tests** fill in the printed command and run it in real temporary repos. They cover edited, new, deleted and renamed files, and running from a subfolder. They also cover a name with a space, and names containing `$`, backticks and `'`.
- **A workflow test** only checks that key wording is present in the skill file.

Three things are left unprotected:

1. Names git escapes with octal bytes, such as non-ASCII names. The test helper cannot even decode them (LOW finding 1).
2. Whether Claude actually follows the skill's instructions. No automated test can check this.
3. The known gap where a chained command's commit is not the first refused step.

All 303 tests pass and doctor reports Ready.

## Unverified Concerns

None. Every concern raised was checked against the repository and is either written up above or listed as a known gap.

## AI Review Conclusion

**PASS.** No blocker or high findings (0 BLOCKER, 0 HIGH). Two LOW findings: one test gap for non-ASCII file names, and one documentation gap in the approved design. Neither blocks the change.

This conclusion is not an approval. A human must read the production diff and run `/dex:approve code commit-before-worktree`.
