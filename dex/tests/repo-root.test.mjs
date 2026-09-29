/**
 * Step 1: Dex finds the main checkout from anywhere.
 *
 * Dex keeps its state in `.dex/` in the main checkout. Implementation happens
 * in a separate git worktree, which has no `.dex/` of its own. Every command
 * and the guard must still find the feature from there, or the gates switch
 * off exactly where the code is being written.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

import {
  advanceTo,
  cleanupRepos,
  completeImplementation,
  gitIn,
  guardBash,
  makeRepo,
  runGuard,
  state,
  stateFails,
  staticText,
  write,
} from './helpers.mjs'
import { findRepoRoot } from '../scripts/lib.mjs'

test.after(cleanupRepos)

// ---------------------------------------------------------------------------
// Finding the main checkout (finding 3)
// ---------------------------------------------------------------------------

test('finding 3: findRepoRoot returns the main checkout from inside a worktree', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  assert.equal(fs.realpathSync(findRepoRoot(worktree)), fs.realpathSync(root))
  assert.equal(fs.realpathSync(findRepoRoot(path.join(worktree, 'src'))), fs.realpathSync(root))
})

test('finding 3: state.mjs finds the feature from the worktree and its subfolders', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  assert.equal((await state(worktree, ['check', 'feat'])).json.slug, 'feat')
  assert.equal((await state(path.join(worktree, 'src'), ['check', 'feat'])).json.slug, 'feat')
})

test('finding 3: without git, Dex still finds .dex by walking up', async () => {
  const root = makeRepo({ git: false })
  await state(root, ['init', 'feat', '--title', 'Feat'])
  assert.equal((await state(path.join(root, 'src'), ['check', 'feat'])).json.slug, 'feat')
})

test('finding 3: the guard denies a push from the worktree before code approval', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  const r = guardBash(worktree, 'git push -u origin dex/feat')
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /feat/)
})

test('finding 3: the guard still allows edits in the worktree once implementation is unlocked', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  const r = runGuard({ cwd: worktree, tool_name: 'Write', tool_input: { file_path: path.join(worktree, 'src/New.java') } })
  assert.equal(r.decision, 'allow')
})

// ---------------------------------------------------------------------------
// Dex's own files do not make the tree look dirty (finding 10)
// ---------------------------------------------------------------------------

function excludeFile(root) {
  const common = gitIn(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  return path.join(common, 'info', 'exclude')
}

test('finding 10: init keeps .dex/ out of git status, and adds the ignore line only once', async () => {
  const root = makeRepo()
  await state(root, ['init', 'feat-a', '--title', 'A'])
  await state(root, ['init', 'feat-b', '--title', 'B'])
  assert.doesNotMatch(gitIn(root, ['status', '--porcelain']), /\.dex/)
  const lines = fs.readFileSync(excludeFile(root), 'utf8').split('\n').filter((l) => l.trim() === '/.dex/')
  assert.equal(lines.length, 1)
})

/** The dirty-tree command from skills/worktree, with the artifact root filled in. */
function worktreeSkillStatusCommand() {
  const skill = staticText('skills/worktree/SKILL.md')[0].text
  const line = skill.split('\n').find((l) => l.trim().startsWith('git status --porcelain'))
  assert.ok(line, 'skills/worktree must run a git status --porcelain check')
  return line.trim().replace(/<artifactRoot>/g, 'docs/dex')
}

test("finding 10: right after init, the worktree skill's dirty check sees a clean tree", async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'plan')
  assert.equal(execSync(worktreeSkillStatusCommand(), { cwd: root, encoding: 'utf8' }).trim(), '')
})

test("finding 10: the worktree skill's dirty check still sees real uncommitted work", async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'plan')
  fs.appendFileSync(path.join(root, 'src', 'PortfolioService.java'), '// unsaved\n')
  assert.match(execSync(worktreeSkillStatusCommand(), { cwd: root, encoding: 'utf8' }), /PortfolioService/)
})

// ---------------------------------------------------------------------------
// Skill text (Q10: Dex's own sibling worktree only; no cd into it)
// ---------------------------------------------------------------------------

test('Q10: the worktree skill creates a sibling worktree and offers no built-in option', () => {
  const skill = staticText('skills/worktree/SKILL.md')[0].text
  assert.doesNotMatch(skill, /native worktree/i)
  assert.match(skill, /git worktree add \.\.\/<repo-name>-dex-<slug> -b dex\/<slug>/)
})

test('Q10: no skill tells Claude to cd into another directory', () => {
  const offenders = staticText('skills/*/SKILL.md')
    .flatMap(({ rel, text }) => text.split('\n').filter((l) => /(^|[;&|]\s*)cd\s/.test(l.trim())).map((l) => `${rel}: ${l.trim()}`))
  assert.deepEqual(offenders, [])
})

// ---------------------------------------------------------------------------
// requireWorktree is read from the live config (finding 23)
// ---------------------------------------------------------------------------

test('finding 23: changing requireWorktree after init changes the worktree gate', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'plan')
  const gate = async () => (await state(root, ['check', 'feat'])).json.gates.worktree.status

  assert.equal(await gate(), 'NOT-READY')
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireWorktree: false }))
  assert.equal(await gate(), 'NOT-REQUIRED')
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireWorktree: true }))
  assert.equal(await gate(), 'NOT-READY')
})

// ---------------------------------------------------------------------------
// record-worktree only accepts a real linked worktree (finding 23)
// ---------------------------------------------------------------------------

async function withWorktree() {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'plan')
  const wt = path.join(path.dirname(root), `${path.basename(root)}-dex-feat`)
  gitIn(root, ['worktree', 'add', '-q', wt, '-b', 'dex/feat'])
  return { root, wt }
}

test('finding 23: record-worktree refuses a folder that is not a git worktree', async () => {
  const { root } = await withWorktree()
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-plain-'))
  const msg = await stateFails(root, ['record-worktree', 'feat', 'dex/feat', plain, '--base', 'main'])
  assert.match(msg, /not a worktree of this repository/)
  fs.rmSync(plain, { recursive: true, force: true })
})

test('finding 23: record-worktree refuses the main checkout', async () => {
  const { root } = await withWorktree()
  const msg = await stateFails(root, ['record-worktree', 'feat', 'main', root, '--base', 'main'])
  assert.match(msg, /main checkout/)
})

test('finding 23: record-worktree refuses a branch name that does not match the worktree', async () => {
  const { root, wt } = await withWorktree()
  const msg = await stateFails(root, ['record-worktree', 'feat', 'dex/other', wt, '--base', 'main'])
  assert.match(msg, /dex\/feat/)
})

test('finding 23: record-worktree refuses a base that is the feature branch itself', async () => {
  const { root, wt } = await withWorktree()
  for (const base of ['HEAD', 'dex/feat']) {
    const msg = await stateFails(root, ['record-worktree', 'feat', 'dex/feat', wt, '--base', base])
    assert.match(msg, /base/)
  }
})

test('finding 23: record-worktree accepts a real worktree with a proper base', async () => {
  const { root, wt } = await withWorktree()
  await state(root, ['record-worktree', 'feat', 'dex/feat', wt, '--base', 'main'])
  assert.equal((await state(root, ['check', 'feat'])).json.gates.worktree.status, 'READY')
})

/** The commit line skills/worktree prints, filled in for untracked and all changed paths. */
function worktreeSkillCommitCommand(untracked, paths) {
  const skill = staticText('skills/worktree/SKILL.md')[0].text
  const line = skill.split('\n').find((l) => l.trim().startsWith('! cd '))
  assert.ok(line, 'skills/worktree must print a ! cd ... && git add ... && git commit line')
  // Single quotes, with a ' in a name written as '\'' — as the skill says.
  const quote = (list) => list.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ')
  return line
    .trim()
    .replace(/^! /, '')
    .replace("'<new path>'", quote(untracked))
    .replace("'<path>' '<path>'", quote(paths))
    .replace('<message>', 'wip')
}

test('the commit line the worktree skill prints commits modified, new, deleted and renamed files', () => {
  const root = makeRepo({ files: { 'a.txt': 'a\n', 'gone.txt': 'g\n', 'old name.txt': 'o\n' } })
  write(root, 'a.txt', 'changed\n')
  write(root, 'new file.txt', 'n\n')
  fs.rmSync(path.join(root, 'gone.txt'))
  gitIn(root, ['mv', 'old name.txt', 'new name.txt'])
  const paths = ['a.txt', 'new file.txt', 'gone.txt', 'old name.txt', 'new name.txt']
  execSync(worktreeSkillCommitCommand(['new file.txt'], paths), { cwd: root, stdio: 'ignore' })
  assert.equal(gitIn(root, ['status', '--porcelain']).trim(), '')
})

test('the printed commit line also works from a subfolder of the repository', () => {
  const root = makeRepo({ files: { 'app/x.js': 'x\n' } })
  write(root, 'app/x.js', 'changed\n')
  write(root, 'app/y.js', 'new\n')
  execSync(worktreeSkillCommitCommand(['app/y.js'], ['app/x.js', 'app/y.js']), { cwd: path.join(root, 'app'), stdio: 'ignore' })
  assert.equal(gitIn(root, ['status', '--porcelain']).trim(), '')
})

/**
 * Paths as the worktree skill tells Claude to read them from `git status
 * --porcelain`: git's own quotes removed and its escapes undone.
 */
function porcelainPaths(root) {
  const real = (p) => (p.startsWith('"') ? JSON.parse(p) : p)
  const untracked = []
  const paths = []
  for (const line of execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)) {
    const names = line.slice(3).split(' -> ').map(real)
    if (line.startsWith('??')) untracked.push(...names)
    paths.push(...names)
  }
  return { untracked, paths }
}

test('the printed commit line works with names read from git status, including quoted ones', () => {
  const root = makeRepo({ files: { 'old name.txt': 'o\n', 'a.txt': 'a\n' } })
  write(root, 'a.txt', 'changed\n')
  write(root, 'new file.txt', 'n\n')
  gitIn(root, ['mv', 'old name.txt', 'renamed file.txt'])
  const { untracked, paths } = porcelainPaths(root)
  assert.ok(execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).includes('"new file.txt"'), 'git quotes names with spaces')
  execSync(worktreeSkillCommitCommand(untracked, paths), { cwd: root, stdio: 'ignore' })
  assert.equal(gitIn(root, ['status', '--porcelain']).trim(), '')
})

test("the printed commit line keeps $, backticks and ' in file names intact", () => {
  const root = makeRepo({ files: { 'routes/users.$id.tsx': 'a\n' } })
  write(root, 'routes/users.$id.tsx', 'changed\n')
  write(root, 'notes `x` $(date).md', 'n\n')
  write(root, "it's.md", 'n\n')
  const { untracked, paths } = porcelainPaths(root)
  execSync(worktreeSkillCommitCommand(untracked, paths), { cwd: root, stdio: 'ignore' })
  assert.equal(gitIn(root, ['status', '--porcelain']).trim(), '')
  assert.equal(gitIn(root, ['log', '-1', '--name-only', '--format=']).trim().split('\n').sort().join('|'),
    ["it's.md", 'notes `x` $(date).md', 'routes/users.$id.tsx'].sort().join('|'))
})
