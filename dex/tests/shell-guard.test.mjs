/**
 * Step 5: the guard understands shell commands.
 *
 * Commands are parsed into simple commands (words plus redirects), wrappers
 * are stripped, and each command is judged by what it runs and where it
 * writes. Most of this file is tables: one row per command, all run through
 * the real guard process.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  advanceTo,
  cleanupRepos,
  completeImplementation,
  gitIn,
  guardBash,
  makeRepo,
  PLUGIN_ROOT,
  runGuard,
  state,
  stateFails,
  staticText,
  write,
} from './helpers.mjs'
import { parseCommand } from '../scripts/shell.mjs'
import { EDIT_TOOLS, SHELL_TOOLS } from '../scripts/guard.mjs'
import { runDoctor } from '../scripts/doctor.mjs'

test.after(cleanupRepos)

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

const argvs = (cmd) => parseCommand(cmd).commands.map((c) => c.argv)
const redirects = (cmd) => parseCommand(cmd).commands.flatMap((c) => c.redirects.map((r) => r.target))

test('shell.mjs: quotes and escapes join into one word', () => {
  assert.deepEqual(argvs(`git pu""sh 'a b' "c d" e\\ f`), [['git', 'push', 'a b', 'c d', 'e f']])
  assert.deepEqual(argvs(`'git' "push"`), [['git', 'push']])
})

test('shell.mjs: operators split commands; quoted operators do not', () => {
  assert.deepEqual(argvs('a; b && c || d | e & f\ng'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']])
  assert.deepEqual(argvs(`echo 'a; b && c > d'`), [['echo', 'a; b && c > d']])
  assert.deepEqual(argvs('! git push'), [['git', 'push']])
})

test('shell.mjs: every redirect form is found, with or without a space', () => {
  assert.deepEqual(redirects('echo x > a; echo x>>b; echo x>|c; echo x &>d; echo x 2>e; echo x>f; echo x 2>&1'), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.deepEqual(redirects(`awk '$1 > 3' f; [[ 3 > 2 ]]`), [])
})

test('shell.mjs: heredoc bodies are not commands', () => {
  const cmd = "cat > docs/x.md <<'EOF'\nrm -rf src\ngit push\nEOF\necho done"
  assert.deepEqual(argvs(cmd), [['cat'], ['echo', 'done']])
  assert.deepEqual(redirects(cmd), ['docs/x.md'])
})

test('shell.mjs: command substitution, sh -c and eval are looked inside', () => {
  const all = (cmd) => argvs(cmd).map((a) => a.join(' '))
  assert.ok(all('echo $(git push)').includes('git push'))
  assert.ok(all('echo `git push`').includes('git push'))
  assert.ok(all(`sh -c "git push origin"`).includes('git push origin'))
  assert.ok(all(`bash -lc 'rm -rf src'`).includes('rm -rf src'))
  assert.ok(all('eval git push').includes('git push'))
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A feature still in design: nothing may change the repository. */
async function inDesign() {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'design')
  return root
}

/** Implemented, verified and reviewed, but not approved by the human. */
async function beforeApproval() {
  const root = makeRepo({ origin: true })
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  return { root, worktree }
}

/** Approved and committed: every publish gate is open. */
async function afterApproval() {
  const ctx = await beforeApproval()
  await state(ctx.root, ['approve', 'code', 'feat'])
  gitIn(ctx.worktree, ['add', '-A'])
  gitIn(ctx.worktree, ['commit', '-qm', 'feature'])
  return ctx
}

// ---------------------------------------------------------------------------
// Publishing (finding 13, Q7)
// ---------------------------------------------------------------------------

const PUBLISH = [
  // git options before push
  'git --no-pager push', 'git --git-dir=.git push', 'git --work-tree=. push', 'git -C. push', 'git -c color.ui=never push',
  // a path, escape or quotes on the command
  '/usr/bin/git push', '\\git push', "'git' push", "git 'push'", 'git pu""sh',
  // wrappers with flags
  'env -i git push', 'env -u X git push', 'command -p git push', 'sudo -u me git push', 'timeout 30 git push',
  'stdbuf -oL git push', 'xargs -n1 git push', 'nice -n 5 git push', 'nohup git push',
  // other separators
  'true & git push', '! git push', 'true\ngit push',
  // nested shells and interpreters
  'sh -c "git push"', "bash -lc 'git push'", 'eval git push', 'echo $(git push)',
  `python3 -c "import os; os.system('git push')"`, `node -e "require('child_process').execSync('git push')"`, 'make push',
  // aliases and plumbing
  'git config alias.p push && git p', 'git -c alias.p=push p', 'git subtree push --prefix=lib origin main', 'git send-pack origin main',
  // GitHub, GitLab and friends
  'gh pr create --fill', 'gh -R o/r pr create --fill', 'gh --repo o/r pr create --fill', 'npx gh pr create --fill', 'gh pr ready 1',
  'gh pr merge 1', 'gh api repos/o/r/pulls -f title=x', 'gh api -X POST repos/o/r/pulls', 'gh api --method=PATCH repos/o/r/pulls/1',
  'hub push', 'hub pull-request', 'glab mr create', 'glab mr merge 1',
  'curl -X POST https://api.github.com/repos/o/r/pulls -d {}', 'curl --data @pr.json https://api.github.com/repos/o/r/pulls',
  // packages and images (Q7)
  'npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'docker push img:1', 'twine upload dist/*', 'gem push x.gem',
  'gh release create v1',
]

test('finding 13: every publish form is denied before code approval', async () => {
  const { worktree } = await beforeApproval()
  const allowed = PUBLISH.filter((cmd) => guardBash(worktree, cmd).decision !== 'deny')
  assert.deepEqual(allowed, [])
})

test('finding 13: every publish form is allowed once the gates are open', async () => {
  const { worktree } = await afterApproval()
  const denied = PUBLISH.filter((cmd) => guardBash(worktree, cmd).decision !== 'allow')
  assert.deepEqual(denied, [])
})

test('finding 41: commands that only mention publishing are not publishing', async () => {
  const { worktree } = await beforeApproval()
  for (const cmd of ['git log --grep send-email', 'git push-to-checkout --help', 'echo "git push"', 'grep -rn "git push" .', 'git help push', 'gh pr view 1', 'gh api repos/o/r/pulls', 'curl https://api.github.com/repos/o/r']) {
    assert.equal(guardBash(worktree, cmd).decision, 'allow', cmd)
  }
})

// ---------------------------------------------------------------------------
// Changes during design (finding 27)
// ---------------------------------------------------------------------------

const CHANGES = [
  'git -C . reset --hard', 'git -C . apply x.patch', 'git -C . checkout -- src', 'git --no-pager commit -m x',
  'git checkout other -- f', 'git checkout HEAD~1 f', 'git checkout -f', 'git checkout -B x', 'git switch other', 'git pull',
  'git stash -u', 'git read-tree -u HEAD', 'git checkout-index -f -a', 'git branch -f main HEAD~1',
  'touch src/A.java', 'mkdir src/new', 'chmod +x src/run.sh', 'install -m 644 a src/a', 'rsync -a /tmp/x/ src/',
  'unlink src/A.java', 'busybox rm src/A.java', '/bin/rm src/A.java', '\\rm src/A.java',
  'sed --in-place s/a/b/ src/A.java', 'sed -i.bak s/a/b/ src/A.java', 'npx prettier --write src', 'eslint --fix src', 'gofmt -w .',
  'cargo fmt', 'black .', 'go generate ./...', 'ruff check --fix .',
  'echo x | tee -a src/A.java', 'echo x | /usr/bin/tee src/A.java', 'echo x>src/A.java', 'echo x &>src/A.java', 'echo x >|src/A.java',
  "sh -c 'rm src/A.java'", `python -c "open('src/A.java','w').write('x')"`, `node -e "require('fs').writeFileSync('src/A.java','x')"`,
]

test('finding 27: every way of changing files is denied during design', async () => {
  const root = await inDesign()
  const allowed = CHANGES.filter((cmd) => guardBash(root, cmd).decision !== 'deny')
  assert.deepEqual(allowed, [])
})

// ---------------------------------------------------------------------------
// Harmless commands during design (finding 26)
// ---------------------------------------------------------------------------

const HARMLESS = [
  "echo 'a > b'", `awk '$1 > 3' src/PortfolioService.java`, '[[ 3 > 2 ]] && echo yes',
  "cat > docs/dex/feat/04-design.md <<'EOF'\n# Design\nrm -rf src\ngit push\nEOF",
  'git log --grep "docs; rm stale notes"',
  'cp docs/dex/feat/04-design.md docs/dex/feat/04-design.bak.md', 'mv docs/dex/feat/a.md docs/dex/feat/b.md',
  'rm docs/dex/feat/old.md', 'mkdir -p docs/dex/feat/img', 'touch docs/dex/feat/notes.md',
  'node /opt/dex/scripts/state.mjs set-slices feat "S1:create > persist"',
  'cat /tmp/x | grep y > /dev/null', 'git diff > /tmp/review.diff', 'npm test 2>&1 | tail -5', 'npm test > $TMPDIR/out.log',
  `node -e "console.log(require('./package.json').name)"`, 'python3 -c "print(1 + 1)"', 'git status && git log --oneline -5',
]

test('finding 26: harmless commands are allowed during design', async () => {
  const root = await inDesign()
  const denied = HARMLESS.filter((cmd) => guardBash(root, cmd).decision !== 'allow')
  assert.deepEqual(denied, [])
})

test('finding 26: saving a test log inside the repo is refused, with a hint to use $TMPDIR', async () => {
  const root = await inDesign()
  const r = guardBash(root, 'npm test > test-output.log')
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /TMPDIR/)
})

// ---------------------------------------------------------------------------
// Paths (finding 14)
// ---------------------------------------------------------------------------

test('finding 14: an edit is judged by where the file really lands', async () => {
  const root = await inDesign()
  const cases = [
    path.join(root, 'docs/dex/../../src/A.java'),
    'docs/dex/../src/A.java',
    path.join(root, '.dex/../src/A.java'),
  ]
  for (const file_path of cases) {
    assert.equal(runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path } }).decision, 'deny', file_path)
  }
})

test('finding 14: a symlink out of the artifact folder does not open a door', async () => {
  const root = await inDesign()
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'docs/dex/feat/link'))
  const r = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs/dex/feat/link/A.java') } })
  assert.equal(r.decision, 'deny')
})

test('finding 14: redirects are resolved before the scratch-folder exemption', async () => {
  const root = await inDesign()
  assert.equal(guardBash(root, 'echo x > docs/dex/../../src/A.java').decision, 'deny')
  assert.equal(guardBash(root, `echo x > /tmp/..${root}/src/A.java`).decision, 'deny')
})

test('finding 14: relative paths are resolved from the command’s own folder', async () => {
  const root = await inDesign()
  const src = path.join(root, 'src')
  assert.equal(guardBash(src, 'echo x > ../docs/dex/feat/n.md').decision, 'allow')
  assert.equal(guardBash(src, 'echo x > docs/dex/feat/n.md').decision, 'deny')
  assert.equal(guardBash(root, 'cd src && echo x > docs/dex/feat/n.md').decision, 'deny')
})

test('finding 14: the feature worktree counts as the repository', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  write(root, 'docs/dex/feat/04-design.md', '# Design\n\nChanged, so implementation is locked again.\n')
  const r = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(worktree, 'src/A.java') } })
  assert.equal(r.decision, 'deny')
})

// ---------------------------------------------------------------------------
// Tools beyond Bash and Write (finding 15)
// ---------------------------------------------------------------------------

test('finding 15: the hook matcher covers every tool the guard knows', () => {
  const pre = JSON.parse(staticText('hooks/hooks.json')[0].text).hooks.PreToolUse[0]
  const matcher = new RegExp(`^(?:${pre.matcher})$`)
  for (const tool of [...EDIT_TOOLS, ...SHELL_TOOLS, 'mcp__filesystem__write_file']) assert.match(tool, matcher, tool)
  assert.equal(pre.hooks[0].timeout, 30)
})

test('finding 15: ApplyPatch targets are read from the patch', async () => {
  const root = await inDesign()
  const patch = (file) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n`
  assert.equal(runGuard({ cwd: root, tool_name: 'ApplyPatch', tool_input: { patch: patch('src/A.java') } }).decision, 'deny')
  assert.equal(runGuard({ cwd: root, tool_name: 'ApplyPatch', tool_input: { patch: patch('docs/dex/feat/04-design.md') } }).decision, 'allow')
})

test('finding 15: MCP tools that write files are checked', async () => {
  const root = await inDesign()
  const call = (tool_name, p) => runGuard({ cwd: root, tool_name, tool_input: { path: p } }).decision
  assert.equal(call('mcp__filesystem__write_file', 'src/A.java'), 'deny')
  assert.equal(call('mcp__filesystem__write_file', 'docs/dex/feat/x.md'), 'allow')
  assert.equal(call('mcp__filesystem__read_file', 'src/A.java'), 'allow')
})

// ---------------------------------------------------------------------------
// The "main script" check (finding 16)
// ---------------------------------------------------------------------------

function runGuardScript(script, cwd, payload) {
  const out = spawnSync('node', [script], { cwd, input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8' })
  return out.stdout.trim()
}

test('finding 16: the guard works through a symlinked plugin folder and odd folder names', async () => {
  const root = await inDesign()
  const payload = { tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/A.java') } }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-plugin-'))
  try {
    fs.symlinkSync(PLUGIN_ROOT, path.join(base, 'link'))
    assert.match(runGuardScript(path.join(base, 'link', 'scripts', 'guard.mjs'), root, payload), /deny/)
    const odd = path.join(base, 'a#b %c', 'dex')
    fs.cpSync(PLUGIN_ROOT, odd, { recursive: true, filter: (src) => !src.includes(`${path.sep}tests${path.sep}`) })
    assert.match(runGuardScript(path.join(odd, 'scripts', 'guard.mjs'), root, payload), /deny/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The pre-push hook (Q12)
// ---------------------------------------------------------------------------

function push(cwd, ...args) {
  return spawnSync('git', ['push', '-q', ...args], { cwd, encoding: 'utf8' })
}

test('Q12: the pre-push hook stops an unapproved dex/* push and allows it once approved', async () => {
  const { root, worktree } = await beforeApproval()
  await state(root, ['install-hook'])
  gitIn(worktree, ['add', '-A'])
  gitIn(worktree, ['commit', '-qm', 'feature'])

  const denied = push(worktree, '-u', 'origin', 'dex/feat')
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /Dex/)

  await state(root, ['approve', 'code', 'feat'])
  const allowed = push(worktree, '-u', 'origin', 'dex/feat')
  assert.equal(allowed.status, 0, allowed.stderr)
})

test('Q12: the pre-push hook ignores branches that are not dex/*', async () => {
  const { root } = await beforeApproval()
  await state(root, ['install-hook'])
  gitIn(root, ['checkout', '-q', '-b', 'topic'])
  const r = push(root, 'origin', 'topic')
  assert.equal(r.status, 0, r.stderr)
})

test('Q12: install-hook never overwrites an existing hook or a custom hooks path', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'init')
  const hooksDir = path.join(root, '.git', 'hooks')
  fs.mkdirSync(hooksDir, { recursive: true })
  fs.writeFileSync(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nexit 0\n')
  const msg = await stateFails(root, ['install-hook'])
  assert.match(msg, /pre-push\.mjs/)
  assert.equal(fs.readFileSync(path.join(hooksDir, 'pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n')

  const other = makeRepo()
  await advanceTo(other, 'feat', 'init')
  gitIn(other, ['config', 'core.hooksPath', '.husky'])
  assert.match(await stateFails(other, ['install-hook']), /core\.hooksPath/)
})

test('Q12: doctor reports whether the pre-push hook is installed', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'init')
  const line = async () => (await runDoctor({ cwd: root })).checks.find((c) => c.name === 'Pre-push hook')
  assert.match((await line()).detail, /not installed/)
  await state(root, ['install-hook'])
  assert.match((await line()).detail, /^installed/)
})
