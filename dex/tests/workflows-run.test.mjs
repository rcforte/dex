/**
 * Step 6: workflows and skills.
 *
 * The workflow scripts are run in Node with a fake agent (see runWorkflow in
 * helpers.mjs), so their logic is tested rather than their text. Skill text is
 * checked where the behaviour lives in the prompt.
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
  makeRepo,
  runWorkflow,
  state,
  staticText,
  write,
} from './helpers.mjs'

test.after(cleanupRepos)

const PATHS = {
  stateScript: '/plugins/dex/scripts/state.mjs',
  templatesDir: '/plugins/dex/templates',
  artifactRoot: 'notes/dex',
  stateRoot: '.dexstate',
}

// ---------------------------------------------------------------------------
// Paths come in through args (finding 9)
// ---------------------------------------------------------------------------

test('finding 9: no workflow reads $CLAUDE_PLUGIN_ROOT; paths come in through args', () => {
  for (const { rel, text } of staticText('workflows/*.js')) assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT/, rel)
})

test('finding 22: the skills start workflows with scriptPath', () => {
  for (const name of ['research', 'review']) {
    const skill = staticText(`skills/${name}/SKILL.md`)[0].text
    // The Workflow tool refuses paths outside the project, so the skill
    // launches a copy staged inside it, never the plugin file.
    assert.match(skill, new RegExp(`state\\.mjs" stage-workflow ${name}`), name)
    assert.match(skill, /scriptPath: <the path stage-workflow printed>/, name)
    assert.doesNotMatch(skill, /scriptPath: \$\{CLAUDE_PLUGIN_ROOT\}/, name)
    assert.match(skill, /refuses to start the script[\s\S]{0,80}\/dex:doctor/, `${name}: refused launch`)
    assert.doesNotMatch(skill, /Workflow tool, script:/, name)
    for (const key of ['stateScript', 'templatesDir', 'artifactRoot', 'stateRoot']) assert.match(skill, new RegExp(`"${key}"`), `${name}: ${key}`)
  }
  const reviewSkill = staticText('skills/review/SKILL.md')[0].text
  for (const key of ['verification', 'tree']) assert.match(reviewSkill, new RegExp(`"${key}"`), `review: ${key}`)
})

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

const q = (n, prefix = 'Q') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, question: `question ${prefix}${i + 1}?` }))

function researchAgent({ questions, humanQuestions = [], fail = [] }) {
  return (prompt, opts) => {
    const label = opts.label || ''
    if (label === 'gate:questions') return { questionsGateStatus: 'APPROVED', featureExists: true }
    if (label === 'parse:questions') return { questions, humanQuestions }
    if (label.startsWith('probe:')) {
      if (fail.includes(label.slice(6))) throw new Error('agent died')
      return { facts: [{ claim: 'x', evidence: 'src/A.java:1-2' }], inferences: [], unknowns: [], relatedTests: [], contradictions: [] }
    }
    if (label.startsWith('verify:')) return { verdicts: [{ claim: 'x', verdict: 'VERIFIED' }] }
    if (label === 'synthesize:research') return 'written'
    throw new Error(`unexpected agent call ${label}`)
  }
}

const research = (args, agent) => runWorkflow('research.js', { slug: 'feat', ...PATHS, ...args }, agent)

test('finding 9: the research gate check runs the state script it was given', async () => {
  const run = await research({ maxWorkers: 6 }, researchAgent({ questions: q(1) }))
  const gate = run.calls.find((c) => c.opts.label === 'gate:questions')
  assert.match(gate.prompt, /\/plugins\/dex\/scripts\/state\.mjs" check feat/)
  const synth = run.calls.find((c) => c.opts.label === 'synthesize:research')
  assert.match(synth.prompt, /\/plugins\/dex\/templates\/research\.md/)
  assert.match(synth.prompt, /notes\/dex\/feat\/03-research\.md/)
})

test('finding 17: every question is researched, including Human Notes, at most maxWorkers at once', async () => {
  const run = await research({ maxWorkers: 6 }, researchAgent({ questions: q(8), humanQuestions: [{ question: 'human one?' }, { question: 'human two?' }] }))
  assert.equal(run.result.ok, true)
  assert.equal(run.result.questionCount, 10)
  assert.equal(run.result.answered, 10)
  assert.ok(run.maxInFlight <= 6, `saw ${run.maxInFlight} agents at once`)
  const probes = run.calls.filter((c) => c.opts.label?.startsWith('probe:'))
  assert.equal(probes.length, 10)
  assert.ok(probes.some((c) => c.prompt.includes('human one?')))
})

test('finding 17: a failed question is listed as unanswered, in the result and the report', async () => {
  const run = await research({ maxWorkers: 6 }, researchAgent({ questions: q(3), fail: ['Q2'] }))
  assert.deepEqual(run.result.unanswered, ['Q2'])
  const synth = run.calls.find((c) => c.opts.label === 'synthesize:research')
  assert.match(synth.prompt, /Q2 \(question Q2\?\)/)
})

test('finding 18: probes run as the read-only research agent and are told to skip Dex folders', async () => {
  const run = await research({ maxWorkers: 6 }, researchAgent({ questions: q(2) }))
  for (const c of run.calls.filter((x) => x.opts.label?.startsWith('probe:'))) {
    assert.equal(c.opts.agentType, 'dex:research-probe')
    assert.match(c.prompt, /notes\/dex\/\*\*/)
    assert.match(c.prompt, /\.dexstate\/\*\*/)
  }
  for (const c of run.calls.filter((x) => x.opts.label?.startsWith('verify:'))) assert.equal(c.opts.agentType, 'dex:research-verifier')
})

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function reviewAgent() {
  return (prompt, opts) => {
    const label = opts.label || ''
    if (label.startsWith('scope')) return { summary: 'adds an optimizer', changedFiles: ['src/A.java'], newFiles: ['src/B.java'] }
    if (label.startsWith('review:')) return { findings: [] }
    if (label.startsWith('consolidate')) return { findings: [], dropped: [], conclusion: 'PASS' }
    return 'ok'
  }
}

const review = (args) =>
  runWorkflow('review.js', { slug: 'feat', worktree: '/wt', base: 'abc123', tree: 'def456', ...PATHS, ...args }, reviewAgent())

test('finding 22: every dimension the review skill names is one review.js knows', () => {
  const skill = staticText('skills/review/SKILL.md')[0].text
  const src = staticText('workflows/review.js')[0].text
  const known = new Set([...src.slice(src.indexOf('const DIMENSION_BRIEF')).matchAll(/^\s+'?([a-z-]+)'?:/gm)].map((m) => m[1]))
  const listed = /Available dimensions: (.+)\./.exec(skill)
  assert.ok(listed, 'the review skill lists "Available dimensions: ..."')
  const named = listed[1].split(',').map((s) => s.trim().replace(/`/g, ''))
  assert.ok(named.length >= 9)
  for (const d of named) assert.ok(known.has(d), d)
})

test('finding 22: the review sees the verification result it is given', async () => {
  const run = await review({ verification: { status: 'PASS', commands: [{ command: 'npm test', exitCode: 0 }] }, dimensions: ['correctness'] })
  const reviewer = run.calls.find((c) => c.opts.label?.startsWith('review:'))
  assert.match(reviewer.prompt, /npm test/)
  assert.doesNotMatch(reviewer.prompt, /were not supplied/)
})

test('finding 22: the review diff is exactly <baseSha>..<tree>, so new files are included', async () => {
  const run = await review({ dimensions: ['correctness'] })
  const scope = run.calls.find((c) => c.opts.label?.startsWith('scope'))
  assert.match(scope.prompt, /diff --stat abc123 def456/)
  assert.match(scope.prompt, /diff abc123 def456/)
})

test('finding 9: the review result names the state script it was given', async () => {
  const run = await review({ dimensions: ['correctness'] })
  assert.match(run.result.recordCommand, /^node "\/plugins\/dex\/scripts\/state\.mjs" record-review feat pass/)
})

test('finding 22: both skills stop on a failed workflow and do not rewrite its report', () => {
  for (const name of ['research', 'review']) {
    const skill = staticText(`skills/${name}/SKILL.md`)[0].text
    assert.match(skill, /`ok` is `false`/, name)
    assert.match(skill, /(?:already wrote|has already written)/, name)
  }
})

// ---------------------------------------------------------------------------
// Tracer line and tool names (findings 37, 39)
// ---------------------------------------------------------------------------

test('finding 37: set-slices warns when the structure requires a tracer and none is recorded', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'structure')
  write(root, 'docs/dex/feat/05-structure.md', '# Program Structure\n\nTracer bullet required: YES\n\n## S1 happy path\n## S2 errors\n')
  await state(root, ['approve', 'structure', 'feat'])
  const out = await state(root, ['set-slices', 'feat', 'S1:happy path', 'S2:errors'])
  assert.match(out.text, /tracer/i)
})

test('finding 37: set-slices warns when checkpoint ids do not match the structure', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'structure')
  write(root, 'docs/dex/feat/05-structure.md', '# Program Structure\n\nTracer bullet required: NO\n\n## S1 one\n## S2 two\n')
  await state(root, ['approve', 'structure', 'feat'])
  const out = await state(root, ['set-slices', 'feat', 'S1:one', 'S3:three'])
  assert.match(out.text, /S2/)
  assert.match(out.text, /S3/)
})

test('finding 39: skills that delegate list the Agent tool, not the old Task name', () => {
  for (const { rel, text } of staticText('skills/*/SKILL.md')) {
    const tools = /^allowed-tools:\s*(.+)$/m.exec(text)?.[1] ?? ''
    assert.doesNotMatch(tools, /\bTask\b/, rel)
  }
})

// ---------------------------------------------------------------------------
// /dex:pr includes the documents (Q11)
// ---------------------------------------------------------------------------

test('Q11: the PR carries the feature documents, and the approval survives copying them in', async () => {
  const root = makeRepo({ origin: true })
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  await state(root, ['install-hook'])
  await state(root, ['approve', 'code', 'feat'])

  // What skills/pr does: copy the documents in, stage, commit, push.
  fs.cpSync(path.join(root, 'docs/dex/feat'), path.join(worktree, 'docs/dex/feat'), { recursive: true })
  gitIn(worktree, ['add', '-A'])
  gitIn(worktree, ['commit', '-qm', 'Portfolio optimization'])
  const push = spawnSync('git', ['push', '-q', '-u', 'origin', 'dex/feat'], { cwd: worktree, encoding: 'utf8' })
  assert.equal(push.status, 0, push.stderr)

  const files = gitIn(root, ['ls-tree', '-r', '--name-only', 'origin/dex/feat']).split('\n')
  assert.ok(files.includes('docs/dex/feat/01-intent.md'))
  assert.ok(files.includes('src/Optimizer.java'))
})

test('Q11: the pr skill copies the feature documents into the worktree before committing', () => {
  const skill = staticText('skills/pr/SKILL.md')[0].text
  const copy = skill.indexOf('cp -R')
  const add = skill.indexOf('add -A')
  assert.ok(copy !== -1 && copy < add, 'copy before add')
})
