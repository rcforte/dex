/**
 * State machine tests: initialization, approval integrity, staleness, and every
 * gate that stands between a feature and a pull request.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  advanceTo,
  cleanupRepos,
  completeImplementation,
  events,
  exists,
  gitIn,
  makeRepo,
  read,
  readState,
  state,
  stateFails,
  write,
} from './helpers.mjs'

test.after(cleanupRepos)

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

test('init creates state, artifact paths, config, and the initialized phase', async () => {
  const root = makeRepo()
  const result = await state(root, ['init', 'portfolio-optimization', '--title', 'Portfolio optimization'])

  assert.equal(result.json.created, true)
  assert.ok(exists(root, '.dex/portfolio-optimization/state.json'))
  assert.ok(exists(root, '.dex/config.json'))
  assert.ok(fs.existsSync(path.join(root, 'docs/dex/portfolio-optimization')))

  const s = readState(root, 'portfolio-optimization')
  assert.equal(s.phase, 'initialized')
  assert.equal(s.feature.slug, 'portfolio-optimization')
  assert.equal(s.feature.title, 'Portfolio optimization')
  assert.equal(s.schemaVersion, 1)
  assert.equal(s.artifacts.design, 'docs/dex/portfolio-optimization/04-design.md')
  assert.equal(s.artifacts.pr, 'docs/dex/portfolio-optimization/09-pr.md')
  assert.deepEqual(s.approvals, { questions: null, design: null, structure: null, humanCodeReview: null })
  assert.equal(s.verification.status, 'not-run')

  assert.equal(read(root, '.dex/active').trim(), 'portfolio-optimization')
  assert.equal(events(root, 'portfolio-optimization')[0].event, 'feature_initialized')
})

test('init refuses to overwrite an existing in-flight feature', async () => {
  const root = makeRepo()
  await state(root, ['init', 'feat', '--title', 'Feature'])
  write(root, 'docs/dex/feat/01-intent.md', '# intent')
  const again = await state(root, ['init', 'feat', '--title', 'Different title'])

  assert.equal(again.json.created, false)
  assert.match(again.text, /already exists/)
  assert.equal(readState(root, 'feat').feature.title, 'Feature')
})

test('an existing .dex/config.json is never overwritten', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireWorktree: false, reviewCadence: 'slice' }))
  await state(root, ['init', 'feat', '--title', 'Feature'])

  const config = JSON.parse(read(root, '.dex/config.json'))
  assert.equal(config.requireWorktree, false)
  assert.equal(config.reviewCadence, 'slice')
  assert.equal((await state(root, ['check', 'feat'])).json.gates.worktree.status, 'NOT-REQUIRED')
})

// ---------------------------------------------------------------------------
// Approval integrity
// ---------------------------------------------------------------------------

test('questions approval stores the artifact hash', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  const result = await state(root, ['approve', 'feat', 'questions'])

  const approval = readState(root, 'feat').approvals.questions
  assert.equal(approval.approved, true)
  assert.match(approval.artifactHash, /^[0-9a-f]{64}$/)
  assert.ok(approval.approvedAt)
  assert.equal(result.json.artifactHash, approval.artifactHash)
  assert.match(result.text, /^APPROVED: questions/m)
  assert.ok(events(root, 'feat').some((e) => e.event === 'questions_approved'))
})

test('approval is refused when the artifact does not exist', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions-approved')
  const msg = await stateFails(root, ['approve', 'feat', 'design'])
  assert.match(msg, /04-design\.md does not exist or is empty/)
})

test('editing an approved artifact makes its approval stale', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions-approved')

  let check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.questions.status, 'APPROVED')

  write(root, 'docs/dex/feat/02-questions.md', '# Research Questions\n\n1. A different question.\n')

  check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.questions.status, 'STALE')
  assert.equal(check.json.gates.questions.approved, false)
  assert.deepEqual(check.json.gates.staleApprovals, ['questions'])

  const status = await state(root, ['status', 'feat'])
  assert.match(status.text, /STALE APPROVAL: questions changed after approval/)
  assert.match(status.text, /Run \/dex:approve questions feat again/)

  const next = await state(root, ['next', 'feat'])
  assert.equal(next.json.command, '/dex:approve questions feat')
})

test('re-approving a changed artifact clears staleness and records a reapproval event', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions-approved')
  write(root, 'docs/dex/feat/02-questions.md', '# changed\n')
  await state(root, ['approve', 'feat', 'questions'])

  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.questions.status, 'APPROVED')
  const approvals = events(root, 'feat').filter((e) => e.event === 'questions_approved')
  assert.equal(approvals.length, 2)
  assert.equal(approvals[1].details.reapproval, true)
})

test('a stale design approval blocks progress even when everything downstream exists', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'structure-approved')
  write(root, 'docs/dex/feat/04-design.md', '# Design\n\nActually use a different component.\n')

  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.design.status, 'STALE')
  assert.equal(check.json.gates.canImplement.allowed, false)
  assert.ok(check.json.gates.canImplement.blockers.some((b) => /design is STALE/.test(b)))
  assert.equal(check.json.next.command, '/dex:approve design feat')
})

// ---------------------------------------------------------------------------
// Upstream gate ordering
// ---------------------------------------------------------------------------

test('design cannot be approved before questions are approved', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  write(root, 'docs/dex/feat/04-design.md', '# Design\n')
  const msg = await stateFails(root, ['approve', 'feat', 'design'])
  assert.match(msg, /will not approve the design while questions are DRAFT/)
})

test('structure cannot be approved before the design is approved', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'design')
  write(root, 'docs/dex/feat/05-structure.md', '# Program Structure\n')
  const msg = await stateFails(root, ['approve', 'feat', 'structure'])
  assert.match(msg, /will not approve the structure while the design is DRAFT/)
  assert.match(msg, /\/dex:approve design feat/)
})

test('the design gate blocks advancing to structure', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'design')
  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.phase, 'design')
  assert.equal(check.json.gates.design.status, 'DRAFT')
  assert.equal(check.json.gates.structure.status, 'MISSING')
  assert.equal(check.json.gates.canImplement.allowed, false)
})

// ---------------------------------------------------------------------------
// Implementation gates
// ---------------------------------------------------------------------------

test('checkpoints cannot be recorded before the structure is approved', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'structure')
  const msg = await stateFails(root, ['set-slices', 'feat', 'S1:tracer'])
  assert.match(msg, /will not record implementation checkpoints while the structure is DRAFT/)
})

test('implementation is blocked before the structure is approved', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'structure')
  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.canImplement.allowed, false)
  assert.ok(check.json.gates.canImplement.blockers.some((b) => /structure is DRAFT/.test(b)))
})

test('implementation is blocked without a tactical plan', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'slices')
  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.plan.status, 'MISSING')
  assert.equal(check.json.gates.canImplement.allowed, false)
  assert.ok(check.json.gates.canImplement.blockers.some((b) => /tactical plan \(06-plan\.md\) does not exist/.test(b)))

  const msg = await stateFails(root, ['start-slice', 'feat', 'S1'])
  assert.match(msg, /tactical plan \(06-plan\.md\) does not exist/)
})

test('implementation is blocked when a worktree is required but not ready', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'plan')
  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.worktree.status, 'NOT-READY')
  assert.equal(check.json.gates.canImplement.allowed, false)
  assert.ok(check.json.gates.canImplement.blockers.some((b) => /worktree is NOT-READY/.test(b)))
  assert.equal(check.json.next.command, '/dex:worktree feat')
})

test('implementation is unlocked when requireWorktree is false', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireWorktree: false }))
  await advanceTo(root, 'feat', 'plan')
  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.worktree.status, 'NOT-REQUIRED')
  assert.equal(check.json.gates.canImplement.allowed, true)
})

test('a recorded worktree whose directory disappeared re-blocks implementation', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  assert.equal((await state(root, ['check', 'feat'])).json.gates.canImplement.allowed, true)

  fs.rmSync(worktree, { recursive: true, force: true })

  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.worktree.status, 'NOT-READY')
  assert.match(check.json.gates.worktree.reason, /recorded worktree path is gone/)
  assert.equal(check.json.gates.canImplement.allowed, false)
})

test('record-worktree refuses a path that does not exist', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'plan')
  const msg = await stateFails(root, ['record-worktree', 'feat', 'dex/feat', path.join(root, 'nope')])
  assert.match(msg, /because that path does not exist/)
})

test('a checkpoint cannot be completed without a verification result', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  await state(root, ['start-slice', 'feat', 'S1'])
  const msg = await stateFails(root, ['finish-slice', 'feat', 'S1'])
  assert.match(msg, /without its verification result/)
})

test('checkpoint ids must be well formed and unique', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'structure-approved')
  assert.match(await stateFails(root, ['set-slices', 'feat', 'phase1:database']), /must look like S1, S2, S3/)
  assert.match(await stateFails(root, ['set-slices', 'feat', 'S1:a', 'S1:b']), /Duplicate checkpoint ids: S1/)
})

test('re-recording checkpoints preserves completed progress', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  await state(root, ['start-slice', 'feat', 'S1'])
  await state(root, ['finish-slice', 'feat', 'S1', '--verification', 'mvn test'])

  await state(root, ['set-slices', 'feat', 'S1:tracer — end to end', 'S2:happy path', 'S3:validation'])
  const slices = readState(root, 'feat').slices
  assert.equal(slices.length, 3)
  assert.equal(slices[0].status, 'complete')
  assert.equal(slices[2].status, 'pending')
})

// ---------------------------------------------------------------------------
// Verification honesty
// ---------------------------------------------------------------------------

/** Finish both checkpoints, so verification and review may be recorded (Q8). */
async function finishSlices(root) {
  for (const id of ['S1', 'S2']) {
    await state(root, ['start-slice', 'feat', id])
    await state(root, ['finish-slice', 'feat', id, '--verification', 'mvn test'])
  }
}

test('verification PASS is refused when any command exited non-zero', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  await finishSlices(root)
  const msg = await stateFails(root, ['verification', 'feat', 'pass', '--command', 'mvn test', '--exit', '1'])
  assert.match(msg, /refuses to record verification PASS/)
  assert.match(msg, /outranks any model's judgment/)
})

test('verification requires at least one command', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  await finishSlices(root)
  assert.match(await stateFails(root, ['verification', 'feat', 'pass']), /will not record verification pass with no commands/)
})

test('verification results persist with exit codes', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  await finishSlices(root)
  await state(root, [
    'verification', 'feat', 'pass',
    '--commands-json', '[{"command":"./gradlew test","exitCode":0,"category":"unit"},{"command":"./gradlew check","exitCode":0,"category":"lint"}]',
  ])
  const v = readState(root, 'feat').verification
  assert.equal(v.status, 'passed')
  assert.equal(v.commands.length, 2)
  assert.equal(v.commands[0].exitCode, 0)
  assert.equal(v.commands[1].category, 'lint')
  assert.ok(v.ranAt)
  assert.ok(events(root, 'feat').some((e) => e.event === 'verification_passed'))
})

test('a failed verification is recorded as failed and blocks the PR', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  await state(root, ['verification', 'feat', 'fail', '--command', 'mvn test', '--exit', '1'])

  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.verification.status, 'FAIL')
  assert.equal(check.json.gates.canPr.allowed, false)
  assert.ok(check.json.gates.canPr.blockers.some((b) => /verification is FAIL/.test(b)))
  assert.ok(events(root, 'feat').some((e) => e.event === 'verification_failed'))
})

// ---------------------------------------------------------------------------
// AI review cannot approve
// ---------------------------------------------------------------------------

test('an AI review with blockers cannot conclude PASS', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  const msg = await stateFails(root, ['record-review', 'feat', 'pass', '--blockers', '2'])
  assert.match(msg, /cannot conclude PASS/)
})

test('a passing AI review does not record a human approval', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)

  const s = readState(root, 'feat')
  assert.equal(s.aiReview.conclusion, 'pass')
  assert.equal(s.approvals.humanCodeReview, null)

  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.aiReview.status, 'PASS')
  assert.equal(check.json.gates.humanCodeReview.status, 'REQUIRED')
  assert.equal(check.json.gates.canPr.allowed, false)
  assert.equal(check.json.next.command, '/dex:approve code feat')
})

test('unresolved BLOCKER findings block the PR', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  await state(root, ['record-review', 'feat', 'remediation-required', '--blockers', '1'])

  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.aiReview.status, 'REMEDIATION-REQUIRED')
  assert.ok(check.json.gates.canPr.blockers.some((b) => /unresolved BLOCKER/.test(b)))
})

// ---------------------------------------------------------------------------
// Human code approval and its diff fingerprint
// ---------------------------------------------------------------------------

test('human code approval binds to a git tree, and changing the code makes it stale', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)

  const approved = await state(root, ['approve', 'feat', 'code'])
  assert.match(approved.json.tree, /^[0-9a-f]{40}$/)
  assert.equal(approved.json.baseSha, gitIn(worktree, ['merge-base', 'main', 'HEAD']).trim())
  assert.match(approved.text, /Any further production change voids it/)

  let check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.humanCodeReview.status, 'APPROVED')
  assert.equal(check.json.gates.canPr.allowed, true)
  assert.equal(check.json.next.command, '/dex:pr feat')

  fs.appendFileSync(path.join(worktree, 'src', 'Optimizer.java'), '// a change made after approval\n')

  check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.humanCodeReview.status, 'STALE')
  assert.equal(check.json.gates.canPr.allowed, false)
  assert.ok(check.json.gates.canPr.blockers.some((b) => /human code review is STALE/.test(b)))

  const status = await state(root, ['status', 'feat'])
  assert.match(status.text, /HUMAN CODE APPROVAL STALE/)
})

test('a NEW untracked source file invalidates the code approval', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  await state(root, ['approve', 'feat', 'code'])

  write(worktree, 'src/SneakyBackdoor.java', 'class SneakyBackdoor {}\n')

  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.humanCodeReview.status, 'STALE')
})

test('editing Dex artifacts does not invalidate the code approval', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  await state(root, ['approve', 'feat', 'code'])

  write(root, 'docs/dex/feat/07-implementation-log.md', '# Log\n\n## S2 complete\n')
  write(root, 'docs/dex/feat/08-review.md', '# AI Review\n\nPASS\n')

  const check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.humanCodeReview.status, 'APPROVED')
  assert.equal(check.json.gates.canPr.allowed, true)
})

test('code approval is refused while verification has not passed', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  fs.appendFileSync(path.join(worktree, 'src', 'PortfolioService.java'), '// work\n')
  const msg = await stateFails(root, ['approve', 'feat', 'code'])
  assert.match(msg, /will not record a human code approval while verification is NOT-RUN/)
})

test('code approval is refused when there is no diff to approve', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  for (const id of ['S1', 'S2']) {
    await state(root, ['start-slice', 'feat', id])
    await state(root, ['finish-slice', 'feat', id, '--verification', 'mvn test'])
  }
  await state(root, ['verification', 'feat', 'pass', '--command', 'mvn test', '--exit', '0'])
  const msg = await stateFails(root, ['approve', 'feat', 'code'])
  assert.match(msg, /no production diff to approve/)
})

// ---------------------------------------------------------------------------
// PR gate
// ---------------------------------------------------------------------------

test('the PR is blocked until every requirement is satisfied', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')

  let msg = await stateFails(root, ['record-pr', 'feat'])
  assert.match(msg, /implementation is PENDING \(0\/2 checkpoints complete\)/)
  assert.match(msg, /verification is NOT-RUN/)
  assert.match(msg, /AI review is NOT-RUN/)
  assert.match(msg, /human code review is REQUIRED/)

  await completeImplementation(root, 'feat', worktree)
  msg = await stateFails(root, ['record-pr', 'feat'])
  assert.match(msg, /human code review is REQUIRED/)
  assert.doesNotMatch(msg, /verification is/)

  await state(root, ['approve', 'feat', 'code'])
  const created = await state(root, ['record-pr', 'feat', '--url', 'https://example.invalid/pr/7'])
  assert.equal(created.json.pr.created, true)
  assert.equal(readState(root, 'feat').phase, 'complete')
  const ev = events(root, 'feat').map((e) => e.event)
  assert.ok(ev.includes('pr_created'))
  assert.ok(ev.includes('feature_completed'))
})

test('the PR is blocked when the approved diff went stale', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  await state(root, ['approve', 'feat', 'code'])
  fs.appendFileSync(path.join(worktree, 'src', 'Optimizer.java'), '// changed after approval\n')

  const msg = await stateFails(root, ['record-pr', 'feat'])
  assert.match(msg, /human code review is STALE/)
})

test('requireAiReview false removes the AI review from the PR gate', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireAiReview: false }))
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  fs.appendFileSync(path.join(worktree, 'src', 'PortfolioService.java'), '// work\n')
  for (const id of ['S1', 'S2']) {
    await state(root, ['start-slice', 'feat', id])
    await state(root, ['finish-slice', 'feat', id, '--verification', 'mvn test'])
  }
  await state(root, ['verification', 'feat', 'pass', '--command', 'mvn test', '--exit', '0'])

  let check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.aiReview.status, 'NOT-REQUIRED')
  assert.equal(check.json.gates.canPr.allowed, false)
  assert.deepEqual(check.json.gates.canPr.blockers, ['human code review is REQUIRED'])

  await state(root, ['approve', 'feat', 'code'])
  check = await state(root, ['check', 'feat'])
  assert.equal(check.json.gates.canPr.allowed, true)
})

// ---------------------------------------------------------------------------
// Design drift
// ---------------------------------------------------------------------------

test('recorded design drift blocks the feature until the artifact is re-approved', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')

  await state(root, ['drift', 'feat', '--reason', 'events are emitted by the unit of work, not the repository', '--slice', 'S2'])
  let check = await state(root, ['check', 'feat'])
  assert.ok(check.json.blocked)
  assert.equal(check.json.gates.canImplement.allowed, false)
  assert.ok(check.json.gates.canImplement.blockers.some((b) => /feature is blocked/.test(b)))
  assert.equal(check.json.next.action, 'resolve-drift')
  assert.equal(readState(root, 'feat').slices[1].status, 'blocked')

  // Revising the design makes its approval stale, so unblocking is refused until
  // a human approves the revision.
  write(root, 'docs/dex/feat/04-design.md', '# Design\n\nRevised: the unit of work owns event publication.\n')
  assert.match(await stateFails(root, ['unblock', 'feat']), /will not unblock "feat" while these approvals are stale: design/)

  await state(root, ['approve', 'feat', 'design'])
  await state(root, ['unblock', 'feat'])

  check = await state(root, ['check', 'feat'])
  assert.equal(check.json.blocked, null)
  assert.equal(check.json.gates.canImplement.allowed, true)
  assert.equal(readState(root, 'feat').slices[1].status, 'pending')
})

// ---------------------------------------------------------------------------
// Atomic writes, locking, event log hygiene
// ---------------------------------------------------------------------------

test('state writes leave no temporary files behind', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'structure-approved')
  const files = fs.readdirSync(path.join(root, '.dex', 'feat'))
  assert.deepEqual(files.filter((f) => f.includes('.tmp')), [])
  assert.deepEqual(files.filter((f) => f === '.lock'), [])
  assert.ok(files.includes('state.json'))
  assert.ok(files.includes('events.jsonl'))
})

test('a held lock refuses a concurrent mutation', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  const lock = path.join(root, '.dex', 'feat', '.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, host: 'other', acquiredAt: new Date().toISOString() }))

  const msg = await stateFails(root, ['approve', 'feat', 'questions'])
  assert.match(msg, /is locked by another process/)
  assert.match(msg, /Two processes must not mutate the same feature state at once/)
  fs.unlinkSync(lock)
})

test('a stale lock is reclaimed', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  const lock = path.join(root, '.dex', 'feat', '.lock')
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, host: 'other', acquiredAt: old }))

  await state(root, ['approve', 'feat', 'questions'])
  assert.equal(readState(root, 'feat').approvals.questions.approved, true)
  assert.equal(fs.existsSync(lock), false)
})

test('the event log never records secrets or prompts', async () => {
  const root = makeRepo()
  const mod = await import('../scripts/lib.mjs')
  const sanitized = mod.sanitizeDetails({
    artifactHash: 'abc',
    apiKey: 'sk-live-should-not-appear',
    AWS_SECRET_ACCESS_KEY: 'nope',
    password: 'hunter2',
    prompt: 'the entire feature conversation',
    authorization: 'Bearer xyz',
    cookie: 'session=1',
    exitCode: 0,
  })
  assert.equal(sanitized.artifactHash, 'abc')
  assert.equal(sanitized.exitCode, 0)
  for (const key of ['apiKey', 'AWS_SECRET_ACCESS_KEY', 'password', 'prompt', 'authorization', 'cookie']) {
    assert.equal(sanitized[key], '[redacted]', `${key} must be redacted`)
  }
  const serialized = JSON.stringify(sanitized)
  assert.doesNotMatch(serialized, /sk-live|hunter2|Bearer xyz/)
})

test('every documented lifecycle event can be produced', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await state(root, ['transition', 'feat', 'research-complete'])
  await completeImplementation(root, 'feat', worktree)
  await state(root, ['approve', 'feat', 'code'])
  await state(root, ['record-pr', 'feat'])

  const names = new Set(events(root, 'feat').map((e) => e.event))
  for (const expected of [
    'feature_initialized', 'questions_approved', 'research_completed', 'design_approved',
    'structure_approved', 'plan_generated', 'worktree_created', 'slice_started',
    'slice_implemented', 'verification_passed', 'ai_review_completed',
    'human_code_review_approved', 'pr_created', 'feature_completed',
  ]) {
    assert.ok(names.has(expected), `missing event: ${expected}`)
  }
})

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('unknown config fields warn and never change behavior', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({
    schemaVersion: 1,
    requireHumanCodeReview: false, // a typo for requireHumanCodeApproval
    totallyMadeUp: 'yes',
  }))
  await state(root, ['init', 'feat', '--title', 'Feature'])
  const check = await state(root, ['check', 'feat'])

  assert.ok(check.json.warnings.some((w) => /unknown config field "requireHumanCodeReview"/.test(w)))
  assert.ok(check.json.warnings.some((w) => /unknown config field "totallyMadeUp"/.test(w)))
  assert.equal(check.json.config.requireHumanCodeApproval, true, 'a typo must not disable the gate')
})

test('wrongly typed config values fall back to the default and warn', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({
    schemaVersion: 1,
    strictGates: 'false',
    reviewCadence: 'whenever',
    maxResearchWorkers: 900,
    artifactRoot: '/etc',
  }))
  await state(root, ['init', 'feat', '--title', 'Feature'])
  const check = await state(root, ['check', 'feat'])

  assert.equal(check.json.config.strictGates, true)
  assert.equal(check.json.config.reviewCadence, 'final')
  assert.equal(check.json.config.maxResearchWorkers, 6)
  assert.ok(check.json.warnings.length >= 4)
})

// ---------------------------------------------------------------------------
// Status, next, and non-git behavior
// ---------------------------------------------------------------------------

test('status renders the lifecycle board with checkpoint detail', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await state(root, ['start-slice', 'feat', 'S1'])
  await state(root, ['finish-slice', 'feat', 'S1', '--verification', 'mvn test'])
  await state(root, ['start-slice', 'feat', 'S2'])

  const { text } = await state(root, ['status', 'feat'])
  assert.match(text, /^Intent\s+COMPLETE$/m)
  assert.match(text, /^Questions\s+APPROVED$/m)
  assert.match(text, /^Design\s+APPROVED$/m)
  assert.match(text, /^Structure\s+APPROVED$/m)
  assert.match(text, /^Worktree\s+READY/m)
  assert.match(text, /S1 tracer.*COMPLETE/)
  assert.match(text, /S2 happy path\s+IN PROGRESS/)
  assert.match(text, /^Human Code Review\s+REQUIRED$/m)
  assert.match(text, /^PR\s+BLOCKED$/m)
})

test('next walks the whole lifecycle in order', async () => {
  const root = makeRepo()
  const expected = [
    ['init', '/dex:start <feature description>'],
    ['questions', '/dex:approve questions feat'],
    ['questions-approved', '/dex:research feat'],
    ['research', '/dex:design feat'],
    ['design', '/dex:approve design feat'],
    ['design-approved', '/dex:structure feat'],
    ['structure', '/dex:approve structure feat'],
    ['structure-approved', '/dex:plan feat'],
    ['plan', '/dex:worktree feat'],
    ['worktree', '/dex:implement feat S1'],
  ]
  for (const [stage, command] of expected) {
    const r = makeRepo()
    await advanceTo(r, 'feat', stage)
    const next = await state(r, ['next', 'feat'])
    assert.equal(next.json.command, command, `at stage "${stage}"`)
  }
  assert.ok(root)
})

test('an unknown feature produces a message naming the real features', async () => {
  const root = makeRepo()
  await state(root, ['init', 'real-feature', '--title', 'Real'])
  const msg = await stateFails(root, ['status', 'nonexistent'])
  assert.match(msg, /has no feature named "nonexistent"/)
  assert.match(msg, /Existing features: real-feature/)
})

test('code approval is refused outside a git repository', async () => {
  const root = makeRepo({ git: false })
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, requireWorktree: false }))
  await advanceTo(root, 'feat', 'plan')
  for (const id of ['S1', 'S2']) {
    await state(root, ['start-slice', 'feat', id])
    await state(root, ['finish-slice', 'feat', id, '--verification', 'mvn test'])
  }
  await state(root, ['verification', 'feat', 'pass', '--command', 'mvn test', '--exit', '0'])
  const msg = await stateFails(root, ['approve', 'feat', 'code'])
  assert.match(msg, /is not a git repository/)
  assert.match(msg, /bound to a git tree/)
})

test('a state file from a different schema version is refused, not guessed at', async () => {
  const root = makeRepo()
  await state(root, ['init', 'feat', '--title', 'Feature'])
  const s = readState(root, 'feat')
  s.schemaVersion = 99
  write(root, '.dex/feat/state.json', JSON.stringify(s))
  const msg = await stateFails(root, ['status', 'feat'])
  assert.match(msg, /different Dex schema/)
  assert.match(msg, /will not guess how to migrate engineering approvals/)
})

test('slug generation is deterministic and drops filler words', async () => {
  const { slugify } = await import('../scripts/lib.mjs')
  assert.equal(slugify('Portfolio optimization'), 'portfolio-optimization')
  assert.equal(slugify('Add the ability to create a portfolio'), 'create-portfolio')
  assert.equal(slugify('Portfolio optimization'), slugify('Portfolio  Optimization!'))
  assert.equal(slugify(''), 'feature')
  assert.equal(slugify('!!!'), 'feature')
})

test('secret-shaped values are scrubbed from the event log, not just secret-named keys', async () => {
  const { scrubSecrets, sanitizeDetails } = await import('../scripts/lib.mjs')

  // A verification command is recorded verbatim, and commands carry credentials.
  const secrets = [
    'curl -H "Authorization: Bearer ghp_ABCDEFGH12345678abcdefgh" https://api.example.com',
    'psql postgres://admin:sup3rs3cret@db.internal:5432/portfolio',
    './gradlew test -Dapi.key=sk_live_abcdef1234567890',
    'mvn verify -Dpassword="hunter2hunter2"',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE ./run.sh',
    'echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
  ]
  for (const s of secrets) {
    const scrubbed = scrubSecrets(s)
    assert.match(scrubbed, /\[redacted\]/, `must scrub: ${s}`)
  }
  assert.doesNotMatch(scrubSecrets(secrets[0]), /ghp_ABCDEFGH/)
  assert.doesNotMatch(scrubSecrets(secrets[1]), /sup3rs3cret/)
  assert.doesNotMatch(scrubSecrets(secrets[3]), /hunter2/)

  // Ordinary verification commands must survive untouched, or the log is useless.
  for (const s of [
    './gradlew :portfolio:test --tests "*PortfolioOptimizerTest"',
    'mvn -q clean verify',
    'npm test -- --coverage',
    'go test ./... -race',
  ]) {
    assert.equal(scrubSecrets(s), s, `must not mangle: ${s}`)
  }

  // And the scrubber applies through the details sanitizer, including in arrays.
  const details = sanitizeDetails({
    commands: [{ command: 'curl -H "Authorization: Bearer ghp_ABCDEFGH12345678abcdefgh" x', exitCode: 0 }],
    note: 'connect with postgres://admin:sup3rs3cret@db/x',
  })
  const serialized = JSON.stringify(details)
  assert.doesNotMatch(serialized, /ghp_ABCDEFGH|sup3rs3cret/)
  assert.match(serialized, /\[redacted\]/)
})

test('a recorded verification command reaches the event log already scrubbed', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  await finishSlices(root)
  await state(root, [
    'verification', 'feat', 'pass',
    '--command', 'curl -sf -H "Authorization: Bearer ghp_ABCDEFGH12345678abcdefgh" http://localhost:8080/health',
    '--exit', '0',
  ])
  const log = read(root, '.dex/feat/events.jsonl')
  assert.doesNotMatch(log, /ghp_ABCDEFGH/)
  assert.match(log, /\[redacted\]/)
})
