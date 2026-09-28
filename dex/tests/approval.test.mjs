/**
 * Step 2: only the human approves.
 *
 * An approval is recorded when the user types `/dex:approve <gate> <slug>`:
 * a UserPromptSubmit hook sees the typed text and records it. The model can
 * neither run the approve command nor edit the state files the gates read.
 * State Dex cannot read makes the guard refuse changes, never allow them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  advanceTo,
  cleanupRepos,
  completeImplementation,
  guardBash,
  makeRepo,
  read,
  readState,
  runGuard,
  runPromptHook,
  state,
  staticText,
  write,
} from './helpers.mjs'
import { DexError, readJson } from '../scripts/lib.mjs'

test.after(cleanupRepos)

const STATE_CLI = '/opt/plugins/dex/scripts/state.mjs'

/** A feature with everything but the human code approval. Returns { root, worktree }. */
async function readyForCodeApproval() {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat', 'worktree')
  await completeImplementation(root, 'feat', worktree)
  return { root, worktree }
}

/** A feature fully approved and ready for a PR. */
async function fullyApproved() {
  const ctx = await readyForCodeApproval()
  await state(ctx.root, ['approve', 'code', 'feat'])
  return ctx
}

// ---------------------------------------------------------------------------
// The approval hook (finding 1, Q15)
// ---------------------------------------------------------------------------

test('finding 1: typing /dex:approve records the approval', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  const out = runPromptHook('/dex:approve questions feat', root)
  assert.equal(out.status, 0)
  assert.ok(readState(root, 'feat').approvals.questions?.approvedAt)
  const context = out.json.hookSpecificOutput.additionalContext
  assert.equal(out.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(context, /APPROVED/)
})

test('finding 1: the hook accepts the leading space Claude Code sends', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  runPromptHook(' /dex:approve questions feat', root)
  assert.ok(readState(root, 'feat').approvals.questions)
})

test('finding 1: the hook ignores every other prompt', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  for (const prompt of ['hello', '/dex:status feat', '/dex:approve questions feat please', '/dex:approve questions ../x', 'please /dex:approve questions feat']) {
    const out = runPromptHook(prompt, root)
    assert.equal(out.status, 0, prompt)
    assert.equal(out.stdout.trim(), '', `no output expected for: ${prompt}`)
  }
  assert.equal(readState(root, 'feat').approvals.questions, null)
})

test('finding 1: a refused approval changes nothing and says why', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'design')
  // Questions are approved at this stage; drop that approval by editing them.
  write(root, 'docs/dex/feat/02-questions.md', '# Research Questions\n\n1. Changed.\n')
  const before = read(root, '.dex/feat/state.json')
  const out = runPromptHook('/dex:approve design feat', root)
  assert.equal(out.status, 0)
  assert.equal(read(root, '.dex/feat/state.json').includes('"design": null'), before.includes('"design": null'))
  assert.match(out.json.hookSpecificOutput.additionalContext, /not record/i)
})

test('finding 1: hooks.json registers the approval hook on UserPromptSubmit', () => {
  const hooks = JSON.parse(staticText('hooks/hooks.json')[0].text).hooks
  const commands = (hooks.UserPromptSubmit || []).flatMap((h) => h.hooks.map((x) => x.command))
  assert.ok(commands.some((c) => c.includes('approve-hook.mjs')), JSON.stringify(commands))
})

test('finding 1: the approve skill never runs the approve command itself', () => {
  const skill = staticText('skills/approve/SKILL.md')[0].text
  // The only approve command left in the skill is the one the user runs in
  // their own terminal; none runs through the plugin path Claude uses.
  assert.doesNotMatch(skill, /CLAUDE_PLUGIN_ROOT\}\/scripts\/state\.mjs"?\s+approve/)
})

// ---------------------------------------------------------------------------
// The guard refuses the model's approvals (finding 1)
// ---------------------------------------------------------------------------

test('finding 1: the guard refuses the model running state.mjs approve', async () => {
  const { root } = await readyForCodeApproval()
  for (const command of [
    `node ${STATE_CLI} approve code feat`,
    `node ${STATE_CLI} approve feat code`,
    `node   "${STATE_CLI}"   approve code feat`,
    `cd /tmp && node ${STATE_CLI} approve code feat`,
    `sh -c "node ${STATE_CLI} approve code feat"`,
  ]) {
    const r = guardBash(root, command)
    assert.equal(r.decision, 'deny', command)
    assert.match(r.reason, /\/dex:approve/, command)
  }
})

test('finding 1: the guard refuses the model approving even with no Dex feature', () => {
  const root = makeRepo()
  assert.equal(guardBash(root, `node ${STATE_CLI} approve design feat`).decision, 'deny')
})

test('finding 1: the guard still allows other state.mjs commands', async () => {
  const { root } = await readyForCodeApproval()
  assert.equal(guardBash(root, `node ${STATE_CLI} status feat`).decision, 'allow')
  assert.equal(guardBash(root, `node ${STATE_CLI} transition feat design-updated`).decision, 'allow')
  assert.equal(guardBash(root, `grep -rn "state.mjs approve" skills/`).decision, 'allow')
})

// ---------------------------------------------------------------------------
// .dex/ is off-limits to the model (finding 2)
// ---------------------------------------------------------------------------

function stateWrites(root) {
  return [
    { tool_name: 'Write', tool_input: { file_path: path.join(root, '.dex/config.json'), content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: '.dex/feat/state.json', old_string: 'a', new_string: 'b' } },
    { tool_name: 'Bash', tool_input: { command: 'echo {} > .dex/config.json' } },
    { tool_name: 'Bash', tool_input: { command: 'cat x | tee .dex/active' } },
    { tool_name: 'Bash', tool_input: { command: 'cp /tmp/x .dex/feat/state.json' } },
    { tool_name: 'Bash', tool_input: { command: 'rm -rf .dex' } },
    { tool_name: 'Bash', tool_input: { command: `mv ${root}/.dex/feat /tmp/gone` } },
  ]
}

test('finding 2: the model cannot write to .dex/ during design', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'design')
  for (const call of stateWrites(root)) {
    assert.equal(runGuard({ cwd: root, ...call }).decision, 'deny', JSON.stringify(call.tool_input))
  }
})

test('finding 2: the model cannot write to .dex/ even when everything is approved', async () => {
  const { root } = await fullyApproved()
  for (const call of stateWrites(root)) {
    const r = runGuard({ cwd: root, ...call })
    assert.equal(r.decision, 'deny', JSON.stringify(call.tool_input))
    assert.match(r.reason, /\.dex/)
  }
})

test('finding 2: artifacts stay writable', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'design')
  const r = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs/dex/feat/04-design.md') } })
  assert.equal(r.decision, 'allow')
  assert.equal(guardBash(root, 'cat src/PortfolioService.java > docs/dex/feat/notes.md').decision, 'allow')
})

test('finding 2: reading .dex/ is still allowed', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'design')
  assert.equal(guardBash(root, 'cat .dex/feat/state.json').decision, 'allow')
  assert.equal(guardBash(root, 'ls .dex').decision, 'allow')
})

// ---------------------------------------------------------------------------
// State Dex cannot read blocks changes (finding 7)
// ---------------------------------------------------------------------------

test('finding 7: readJson returns the fallback only for a missing file', () => {
  const root = makeRepo()
  assert.equal(readJson(path.join(root, 'missing.json'), null), null)
  write(root, 'bad.json', '{')
  assert.throws(() => readJson(path.join(root, 'bad.json'), null), DexError)
})

async function corrupt(root) {
  fs.writeFileSync(path.join(root, '.dex/feat/state.json'), '{ "schemaVersion": 1, ')
}

test('finding 7: a corrupt state file blocks changes and publishing', async () => {
  const { root } = await fullyApproved()
  await corrupt(root)
  const write_ = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/A.java') } })
  assert.equal(write_.decision, 'deny')
  assert.match(write_.reason, /could not read/i)
  assert.equal(guardBash(root, 'git push').decision, 'deny')
  assert.equal(guardBash(root, 'rm src/PortfolioService.java').decision, 'deny')
})

test('finding 7: a corrupt state file still allows reading', async () => {
  const { root } = await fullyApproved()
  await corrupt(root)
  assert.equal(guardBash(root, 'cat src/PortfolioService.java').decision, 'allow')
  assert.equal(guardBash(root, 'git status').decision, 'allow')
})

test('finding 7: an active marker naming a missing feature blocks changes', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat-a', 'worktree')
  await advanceTo(root, 'feat-b', 'design')
  fs.writeFileSync(path.join(root, '.dex/active'), 'gone\n')
  const r = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/A.java') } })
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /gone/)
})

test('finding 7: a config that is not an object blocks changes instead of crashing open', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  fs.writeFileSync(path.join(root, '.dex/config.json'), '[]')
  const r = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/A.java') } })
  assert.equal(r.decision, 'deny')
})

// ---------------------------------------------------------------------------
// Choosing which feature to check (finding 19)
// ---------------------------------------------------------------------------

test('finding 19: an edit inside a feature worktree is checked against that feature', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat-a', 'worktree') // A may implement
  await advanceTo(root, 'feat-b', 'design') // B is active and still in design
  const inA = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(worktree, 'src/X.java') } })
  assert.equal(inA.decision, 'allow')
  const inMain = runGuard({ cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/X.java') } })
  assert.equal(inMain.decision, 'deny')
  assert.match(inMain.reason, /feat-b/)
})

test('finding 19: a shell command run from a feature worktree is checked against that feature', async () => {
  const root = makeRepo()
  const { worktree } = await advanceTo(root, 'feat-a', 'worktree')
  await completeImplementation(root, 'feat-a', worktree)
  await advanceTo(root, 'feat-b', 'design')
  const r = guardBash(worktree, 'git push -u origin dex/feat-a')
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /feat-a/)
})

test('finding 19: commands that change a feature make it the active one', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat-a', 'worktree')
  await advanceTo(root, 'feat-b', 'design')
  assert.equal(read(root, '.dex/active').trim(), 'feat-b')
  await state(root, ['start-slice', 'feat-a', 'S1'])
  assert.equal(read(root, '.dex/active').trim(), 'feat-a')
})

test('finding 19: several active features and no usable marker block changes', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat-a', 'worktree')
  await advanceTo(root, 'feat-b', 'plan')
  fs.rmSync(path.join(root, '.dex/active'))
  const r = guardBash(root, 'rm -rf src')
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /feat-a/)
})
