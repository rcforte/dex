/**
 * End to end: the documented Dex flow, driven the way the skills drive it.
 *
 * Every step goes through the real state CLI and the real guard process, in a
 * repository with a real `origin`. The worktree is created where
 * skills/worktree puts it (`../<repo>-dex-<slug>`), and the PR step stages and
 * commits exactly as skills/pr does.
 *
 * These tests fail on the reviewed code. They are marked `todo` so the suite
 * stays green while they do. Remove each `todo` when its fix lands; the plan
 * expects all of them to pass by the end of step 3.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupRepos, gitIn, guardBash, makeRepo, state, write } from './helpers.mjs'

test.after(cleanupRepos)

const SLUG = 'feat'
const DOCS = `docs/dex/${SLUG}`

/** /dex:start through /dex:plan: every artifact written and every gate approved. */
async function planned(root) {
  await state(root, ['init', SLUG, '--title', 'Portfolio optimization'])
  write(root, `${DOCS}/01-intent.md`, '# Feature Intent\n\nProblem: optimization is manual.\n')
  write(root, `${DOCS}/02-questions.md`, '# Research Questions\n\n1. Where does creation enter?\n')
  await state(root, ['approve', 'questions', SLUG])
  write(root, `${DOCS}/03-research.md`, '# Codebase Research\n\nFACT: src/PortfolioService.java:1-1\n')
  write(root, `${DOCS}/04-design.md`, '# Design\n\nUse PortfolioService.\n')
  await state(root, ['approve', 'design', SLUG])
  write(root, `${DOCS}/05-structure.md`, '# Program Structure\n\nTracer bullet required: NO\n')
  await state(root, ['approve', 'structure', SLUG])
  await state(root, ['set-slices', SLUG, 'S1:end to end'])
  write(root, `${DOCS}/06-plan.md`, '# Tactical Plan\n\n## Checkpoint S1\n')
}

/** /dex:worktree, as the skill does it. Returns the worktree path. */
async function worktree(root) {
  const wt = path.join(path.dirname(root), `${path.basename(root)}-dex-${SLUG}`)
  gitIn(root, ['worktree', 'add', '-q', wt, '-b', `dex/${SLUG}`])
  await state(root, ['record-worktree', SLUG, `dex/${SLUG}`, wt, '--base', 'main'])
  return wt
}

/** /dex:implement S1, /dex:verify and /dex:review. Stops before human code approval. */
async function implemented(root, wt) {
  await state(root, ['start-slice', SLUG, 'S1'])
  fs.appendFileSync(path.join(wt, 'src', 'PortfolioService.java'), '// optimization\n')
  write(wt, 'src/Optimizer.java', 'class Optimizer {}\n')
  await state(root, ['finish-slice', SLUG, 'S1', '--verification', 'node -e 0'])
  await state(root, ['verification', SLUG, 'pass', '--command', 'node -e 0', '--exit', '0'])
  await state(root, ['record-review', SLUG, 'pass', '--blockers', '0'])
}

/** The staging and commit that skills/pr runs before it pushes. */
function commitLikePr(wt) {
  gitIn(wt, ['add', '-A'])
  gitIn(wt, ['commit', '-qm', 'Portfolio optimization'])
}

test('finding 10: right after /dex:start, the worktree skill sees a clean tree', async () => {
  const root = makeRepo({ origin: true })
  await planned(root)
  // The check skills/worktree runs before creating the worktree.
  assert.equal(gitIn(root, ['status', '--porcelain', '--', '.', ':!docs/dex']).trim(), '')
})

test('finding 3: Dex finds the feature from inside the worktree', async () => {
  const root = makeRepo({ origin: true })
  await planned(root)
  const wt = await worktree(root)
  const out = await state(wt, ['check', SLUG])
  assert.equal(out.json.slug, SLUG)
})

test('finding 3: a push from the worktree before code approval is denied', async () => {
  const root = makeRepo({ origin: true })
  await planned(root)
  const wt = await worktree(root)
  await implemented(root, wt)
  // From the main checkout this is already denied; from the worktree it is not.
  assert.equal(guardBash(root, `git -C ${wt} push -u origin dex/${SLUG}`).decision, 'deny')
  assert.equal(guardBash(wt, `git push -u origin dex/${SLUG}`).decision, 'deny')
})

test('findings 3 and 4: the documented flow ends with an allowed push', { todo: 'fixed in step 3' }, async () => {
  const root = makeRepo({ origin: true })
  await planned(root)
  const wt = await worktree(root)
  await implemented(root, wt)
  await state(root, ['approve', 'code', SLUG])

  commitLikePr(wt)

  const gates = (await state(root, ['check', SLUG])).json.gates
  assert.equal(gates.humanCodeReview.status, 'APPROVED', 'staging and committing must not make the approval stale')
  assert.equal(gates.canPr.allowed, true, `canPr blocked: ${JSON.stringify(gates.canPr)}`)
  assert.equal(guardBash(root, `git -C ${wt} push -u origin dex/${SLUG}`).decision, 'allow')
  assert.equal(guardBash(wt, `git push -u origin dex/${SLUG}`).decision, 'allow')
})
