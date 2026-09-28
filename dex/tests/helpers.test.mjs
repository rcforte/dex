/**
 * Tests for the test helpers themselves. A helper that quietly does the wrong
 * thing makes every test built on it meaningless, so each one is checked once
 * against something whose answer is already known.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  advanceTo,
  cleanupRepos,
  gitIn,
  guardBash,
  makeRepo,
  runGuard,
  runWorkflow,
  staticText,
} from './helpers.mjs'

test.after(cleanupRepos)

test('makeRepo with origin pushes main to a bare remote', () => {
  const root = makeRepo({ origin: true })
  const remote = gitIn(root, ['remote', 'get-url', 'origin']).trim()
  assert.ok(remote.length > 0)
  assert.equal(gitIn(root, ['rev-parse', 'origin/main']).trim(), gitIn(root, ['rev-parse', 'main']).trim())
})

test('runGuard reports deny and allow from the real hook process', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'design')
  const denied = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/Foo.java') } })
  assert.equal(denied.decision, 'deny')
  assert.match(denied.reason, /production code/)
  const allowed = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs/dex/feat/04-design.md') } })
  assert.equal(allowed.decision, 'allow')
  assert.equal(guardBash(root, 'git status').decision, 'allow')
})

/** A fake agent that answers the research workflow's calls by label. */
function researchAgent({ questions, failProbe = null } = {}) {
  return (prompt, opts) => {
    const label = opts.label || ''
    if (label === 'gate:questions') return { questionsGateStatus: 'APPROVED', featureExists: true }
    if (label === 'parse:questions') return { questions }
    if (label.startsWith('probe:')) {
      if (label === `probe:${failProbe}`) throw new Error('agent died')
      return { facts: [{ claim: `fact for ${label}`, evidence: 'src/A.java:1-2' }], inferences: [], unknowns: [], relatedTests: [], contradictions: [] }
    }
    if (label.startsWith('verify:')) return { verdicts: [{ claim: 'x', verdict: 'VERIFIED' }] }
    if (label === 'synthesize:research') return 'report written'
    throw new Error(`unexpected agent call: ${label}`)
  }
}

test('runWorkflow runs research.js end to end with a fake agent', async () => {
  const questions = [
    { id: 'Q1', question: 'Where do requests enter?' },
    { id: 'Q2', question: 'How is data stored?' },
  ]
  const run = await runWorkflow('research.js', { slug: 'feat', maxWorkers: 6 }, researchAgent({ questions }))
  assert.equal(run.result.ok, true)
  assert.equal(run.result.answered, 2)
  assert.deepEqual(run.result.findings, { verified: 2, partiallyVerified: 0, unverified: 0, contradicted: 0 })
  assert.deepEqual(run.phases, ['Check gate', 'Parse questions', 'Synthesize'])
  assert.deepEqual(
    run.calls.map((c) => c.opts.label),
    ['gate:questions', 'parse:questions', 'probe:Q1', 'probe:Q2', 'verify:Q1', 'verify:Q2', 'synthesize:research']
  )
})

test('runWorkflow turns a failing agent into null, as the Workflow tool does', async () => {
  const questions = [
    { id: 'Q1', question: 'Where do requests enter?' },
    { id: 'Q2', question: 'How is data stored?' },
  ]
  const run = await runWorkflow('research.js', { slug: 'feat' }, researchAgent({ questions, failProbe: 'Q2' }))
  assert.equal(run.result.ok, true)
  assert.deepEqual(run.result.unanswered, ['Q2'])
})

test('runWorkflow enforces its concurrency limit', async () => {
  const questions = Array.from({ length: 5 }, (_, i) => ({ id: `Q${i + 1}`, question: `q${i + 1}` }))
  const one = await runWorkflow('research.js', { slug: 'feat' }, researchAgent({ questions }), { concurrency: 1 })
  assert.equal(one.maxInFlight, 1)
  const many = await runWorkflow('research.js', { slug: 'feat' }, researchAgent({ questions }))
  assert.ok(many.maxInFlight > 1, `expected concurrent agents, saw ${many.maxInFlight}`)
})

test('staticText matches single segments and any depth', () => {
  assert.equal(staticText('skills/*/SKILL.md').length, 16)
  assert.deepEqual(staticText('workflows/*.js').map((f) => f.rel), ['workflows/research.js', 'workflows/review.js'])
  assert.deepEqual(staticText('**/hooks.json').map((f) => f.rel), ['hooks/hooks.json'])
  assert.match(staticText('hooks/hooks.json')[0].text, /PreToolUse/)
})

// runPromptHook is exercised in step 2, when scripts/approve-hook.mjs exists.
