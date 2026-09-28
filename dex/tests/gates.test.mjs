/**
 * Step 4: gate rules.
 *
 * - Implementation and publishing need every upstream approval, current.
 * - Re-approving an earlier document makes the next approval stale (one level).
 * - strictGates:false relaxes the order of approvals, never their presence.
 * - After design drift, only a fresh approval unblocks the feature.
 * - Checkpoints are recorded in order and cannot silently disappear.
 * - A flag given without a value is an error, not the string "true".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  advanceTo,
  cleanupRepos,
  completeImplementation,
  gitIn,
  guardBash,
  makeRepo,
  readState,
  runPromptHook,
  state,
  stateFails,
  write,
} from './helpers.mjs'

test.after(cleanupRepos)

const check = async (root) => (await state(root, ['check', 'feat'])).json
const D = 'docs/dex/feat'

/** Ready to implement: every approval current, plan written, worktree recorded. */
async function readyToImplement() {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  return { root, worktree }
}

/** Ready to publish: implemented, verified, reviewed, approved and committed. */
async function readyToPublish() {
  const { root, worktree } = await readyToImplement()
  await completeImplementation(root, 'feat', worktree)
  await state(root, ['approve', 'code', 'feat'])
  gitIn(worktree, ['add', '-A'])
  gitIn(worktree, ['commit', '-qm', 'feature'])
  assert.equal((await check(root)).gates.canPr.allowed, true)
  return { root, worktree }
}

// ---------------------------------------------------------------------------
// canImplement (finding 12)
// ---------------------------------------------------------------------------

const IMPLEMENT_BREAKERS = {
  'stale questions': (root) => write(root, `${D}/02-questions.md`, '# Research Questions\n\n1. Changed.\n'),
  'a missing plan': (root) => fs.rmSync(path.join(root, `${D}/06-plan.md`)),
}

for (const [name, breakIt] of Object.entries(IMPLEMENT_BREAKERS)) {
  test(`finding 12: ${name} blocks implementation`, async () => {
    const { root } = await readyToImplement()
    assert.equal((await check(root)).gates.canImplement.allowed, true)
    breakIt(root)
    const gates = (await check(root)).gates
    assert.equal(gates.canImplement.allowed, false)
  })
}

test('finding 12: stale questions are named as the reason implementation is blocked', async () => {
  const { root } = await readyToImplement()
  IMPLEMENT_BREAKERS['stale questions'](root)
  assert.ok((await check(root)).gates.canImplement.blockers.some((b) => /questions/.test(b)))
})

// ---------------------------------------------------------------------------
// canPr re-checks everything upstream (finding 8)
// ---------------------------------------------------------------------------

const PR_BREAKERS = {
  'a stale design': { pattern: /design/, run: ({ root }) => write(root, `${D}/04-design.md`, '# Design\n\nChanged.\n') },
  'a stale structure': { pattern: /structure/, run: ({ root }) => write(root, `${D}/05-structure.md`, '# Program Structure\n\nChanged.\n') },
  'a missing plan': { pattern: /plan/, run: ({ root }) => fs.rmSync(path.join(root, `${D}/06-plan.md`)) },
  'a missing worktree': { pattern: /worktree/, run: ({ worktree }) => fs.rmSync(worktree, { recursive: true, force: true }) },
  'a blocked checkpoint': {
    pattern: /checkpoint|implementation/,
    run: ({ root }) => state(root, ['block-slice', 'feat', 'S2', '--reason', 'reopened']),
  },
}

for (const [name, { pattern, run }] of Object.entries(PR_BREAKERS)) {
  test(`finding 8: ${name} blocks the PR and the push`, async () => {
    const ctx = await readyToPublish()
    await run(ctx)
    const gates = (await check(ctx.root)).gates
    assert.equal(gates.canPr.allowed, false)
    assert.ok(gates.canPr.blockers.some((b) => pattern.test(b)), JSON.stringify(gates.canPr.blockers))
    assert.equal(guardBash(ctx.root, `git -C ${ctx.worktree} push -u origin dex/feat`).decision, 'deny')
  })
}

// ---------------------------------------------------------------------------
// One-level staleness (Q4)
// ---------------------------------------------------------------------------

test('Q4: re-approving changed questions makes the design stale, not the structure', async () => {
  const { root } = await readyToImplement()
  write(root, `${D}/02-questions.md`, '# Research Questions\n\n1. Changed.\n')
  await state(root, ['approve', 'questions', 'feat'])
  const gates = (await check(root)).gates
  assert.equal(gates.questions.status, 'APPROVED')
  assert.equal(gates.design.status, 'STALE')
  assert.match(gates.design.reason, /questions/)
  assert.equal(gates.structure.status, 'APPROVED')
})

test('Q4: re-approving a changed design makes the structure stale', async () => {
  const { root } = await readyToImplement()
  write(root, `${D}/04-design.md`, '# Design\n\nChanged.\n')
  await state(root, ['approve', 'design', 'feat'])
  const gates = (await check(root)).gates
  assert.equal(gates.design.status, 'APPROVED')
  assert.equal(gates.structure.status, 'STALE')
  assert.match(gates.structure.reason, /design/)
})

// ---------------------------------------------------------------------------
// strictGates:false relaxes order only (Q5)
// ---------------------------------------------------------------------------

test('Q5: strictGates false allows approving out of order', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, strictGates: false }))
  await advanceTo(root, 'feat', 'design')
  // Drop the questions approval by changing the file, then approve the design anyway.
  write(root, `${D}/02-questions.md`, '# Research Questions\n\n1. Changed.\n')
  await state(root, ['approve', 'design', 'feat'])
  assert.equal((await check(root)).gates.design.status, 'APPROVED')
})

test('Q5: strictGates false never removes an approval requirement', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, strictGates: false }))
  await advanceTo(root, 'feat', 'research')
  write(root, `${D}/04-design.md`, '# Design\n')
  write(root, `${D}/05-structure.md`, '# Program Structure\n\nTracer bullet required: NO\n')
  await state(root, ['approve', 'structure', 'feat']) // allowed without a design approval
  await state(root, ['set-slices', 'feat', 'S1:one'])
  write(root, `${D}/06-plan.md`, '# Plan\n')
  const gates = (await check(root)).gates
  assert.equal(gates.canImplement.allowed, false)
  assert.ok(gates.canImplement.blockers.some((b) => /design/.test(b)))
  assert.equal(gates.canPr.allowed, false)
  assert.ok(gates.canPr.blockers.some((b) => /design/.test(b)))
})

// ---------------------------------------------------------------------------
// An emptied approved file is stale (finding 36)
// ---------------------------------------------------------------------------

test('finding 36: emptying an approved file makes its approval STALE, not MISSING', async () => {
  const { root } = await readyToImplement()
  write(root, `${D}/04-design.md`, '')
  const gates = (await check(root)).gates
  assert.equal(gates.design.status, 'STALE')
  assert.ok(gates.staleApprovals.includes('design'))
})

// ---------------------------------------------------------------------------
// Drift (finding 20)
// ---------------------------------------------------------------------------

test('finding 20: unblock is refused until a fresh approval', async () => {
  const { root } = await readyToImplement()
  await state(root, ['drift', 'feat', '--target', 'design', '--reason', 'the repository uses events, not calls'])
  assert.match(await stateFails(root, ['unblock', 'feat']), /approve/)
  assert.ok(readState(root, 'feat').blocked)
})

test('finding 20: deleting the design does not unblock the feature', async () => {
  const { root } = await readyToImplement()
  await state(root, ['drift', 'feat', '--target', 'design', '--reason', 'x'])
  fs.rmSync(path.join(root, `${D}/04-design.md`))
  await stateFails(root, ['unblock', 'feat'])
  assert.ok(readState(root, 'feat').blocked)
})

test('finding 20: re-approving the revised documents unblocks the feature by itself', async () => {
  const { root } = await readyToImplement()
  await state(root, ['drift', 'feat', '--target', 'design', '--reason', 'x'])
  write(root, `${D}/04-design.md`, '# Design\n\nRevised for events.\n')

  runPromptHook('/dex:approve design feat', root)
  // The structure was built on the old design, so it needs a fresh look too.
  let json = await check(root)
  assert.ok(json.blocked, 'still blocked while the structure is stale')
  assert.equal(json.next.command, '/dex:approve structure feat')

  runPromptHook('/dex:approve structure feat', root)
  json = await check(root)
  assert.equal(json.blocked, null)
  assert.match(json.next.command, /^\/dex:implement feat/)
})

test('finding 20: drift names the document to revise', async () => {
  const { root } = await readyToImplement()
  await state(root, ['drift', 'feat', '--target', 'structure', '--reason', 'route changed'])
  assert.equal((await check(root)).next.command, '/dex:structure feat')
})

test('finding 20: drift checks its input', async () => {
  const { root } = await readyToImplement()
  assert.match(await stateFails(root, ['drift', 'feat', '--target', 'design', '--reason', 'x', '--slice', 'S9']), /S9/)
  assert.match(await stateFails(root, ['drift', 'feat', '--target', 'design', '--reason']), /needs a value/)
  assert.match(await stateFails(root, ['drift', 'feat', '--target', 'plan', '--reason', 'x']), /design|structure/)
})

test('finding 20: unblocking resets only the checkpoint the drift blocked', async () => {
  const { root } = await readyToImplement()
  await state(root, ['block-slice', 'feat', 'S2', '--reason', 'waiting on another team'])
  await state(root, ['drift', 'feat', '--target', 'structure', '--reason', 'x', '--slice', 'S1'])
  write(root, `${D}/05-structure.md`, '# Program Structure\n\nRevised.\n')
  runPromptHook('/dex:approve structure feat', root)
  const s = readState(root, 'feat')
  assert.equal(s.blocked, null)
  assert.equal(s.slices.find((x) => x.id === 'S1').status, 'pending')
  assert.equal(s.slices.find((x) => x.id === 'S2').status, 'blocked')
})

test('finding 35: drift updates the stored phase', async () => {
  const { root } = await readyToImplement()
  await state(root, ['start-slice', 'feat', 'S1'])
  await state(root, ['drift', 'feat', '--target', 'design', '--reason', 'x', '--slice', 'S1'])
  const stored = readState(root, 'feat').phase
  assert.equal(stored, (await check(root)).phase)
})

// ---------------------------------------------------------------------------
// Checkpoints (finding 21)
// ---------------------------------------------------------------------------

test('finding 21: a checkpoint cannot be finished without being started', async () => {
  const { root } = await readyToImplement()
  assert.match(await stateFails(root, ['finish-slice', 'feat', 'S1', '--verification', 'npm test']), /start/)
})

test('finding 21: a checkpoint cannot be finished while the feature is blocked', async () => {
  const { root } = await readyToImplement()
  await state(root, ['start-slice', 'feat', 'S1'])
  await state(root, ['drift', 'feat', '--target', 'design', '--reason', 'x'])
  assert.match(await stateFails(root, ['finish-slice', 'feat', 'S1', '--verification', 'npm test']), /blocked/)
})

test('finding 21: set-slices will not silently drop a recorded checkpoint', async () => {
  const { root } = await readyToImplement()
  assert.match(await stateFails(root, ['set-slices', 'feat', 'S1:tracer — end to end']), /S2/)
  await state(root, ['set-slices', 'feat', 'S1:tracer — end to end', '--replace'])
  assert.deepEqual(readState(root, 'feat').slices.map((s) => s.id), ['S1'])
})

test('finding 21: set-slices cannot change the checkpoints once one has started', async () => {
  const { root } = await readyToImplement()
  await state(root, ['start-slice', 'feat', 'S1'])
  assert.match(await stateFails(root, ['set-slices', 'feat', 'S1:a', 'S2:b', 'S3:c', '--replace']), /started/)
  // Renaming the same checkpoints is fine.
  await state(root, ['set-slices', 'feat', 'S1:tracer renamed', 'S2:happy path'])
  assert.equal(readState(root, 'feat').slices[0].status, 'in-progress')
})

test('finding 21: checkpoint ids are normalised, so S01 and S1 are the same checkpoint', async () => {
  const { root } = await readyToImplement()
  assert.match(await stateFails(root, ['set-slices', 'feat', 'S01:a', 'S1:b', 'S2:c']), /Duplicate/)
  await state(root, ['set-slices', 'feat', 'S01:a', 'S02:b'])
  assert.deepEqual(readState(root, 'feat').slices.map((s) => s.id), ['S1', 'S2'])
})

// ---------------------------------------------------------------------------
// Flags need values (finding 20, 21)
// ---------------------------------------------------------------------------

const VALUE_FLAGS = [
  ['init', 'title'],
  ['finish-slice', 'verification'],
  ['finish-slice', 'note'],
  ['block-slice', 'reason'],
  ['verification', 'command'],
  ['verification', 'exit'],
  ['verification', 'summary'],
  ['verification', 'commands-json'],
  ['record-review', 'blockers'],
  ['record-review', 'high'],
  ['record-worktree', 'base'],
  ['record-pr', 'url'],
  ['drift', 'reason'],
  ['drift', 'slice'],
  ['drift', 'target'],
  ['events', 'limit'],
]

test('flags given without a value are refused', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'init')
  for (const [command, flag] of VALUE_FLAGS) {
    const msg = await stateFails(root, [command, 'feat', `--${flag}`])
    assert.match(msg, new RegExp(`--${flag} needs a value`), `${command} --${flag}`)
  }
})
