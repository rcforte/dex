/**
 * Step 7: hygiene.
 *
 * Secrets never reach disk, slugs are checked before anything is touched,
 * `approve` takes one argument order, locks survive half-written files and
 * clock skew, and doctor writes nothing but its staged workflow copies.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { advanceTo, cleanupRepos, gitIn, makeRepo, read, state, stateFails, STATE_CLI, write } from './helpers.mjs'
import { runDoctor } from '../scripts/doctor.mjs'

test.after(cleanupRepos)

/** Finish both checkpoints so verification can be recorded. */
async function finished(root) {
  for (const id of ['S1', 'S2']) {
    await state(root, ['start-slice', 'feat', id])
    await state(root, ['finish-slice', 'feat', id, '--verification', 'mvn test'])
  }
}

// ---------------------------------------------------------------------------
// Secrets (finding 24)
// ---------------------------------------------------------------------------

const GOOGLE_KEY = 'AIzaSy' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r'
const SECRETS = [
  { text: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY aws s3 ls', secret: 'wJalrXUtnFEMIK7MDENG' },
  { text: 'curl -u admin:hunter2secret https://example.com', secret: 'hunter2secret' },
  { text: 'mysql -phunter2secret -u root app', secret: 'hunter2secret' },
  { text: `curl "https://maps.example.com/api?key=${GOOGLE_KEY}"`, secret: GOOGLE_KEY.slice(0, 20) },
  { text: 'DB_PASSWORD=correct-horse-battery npm test', secret: 'correct-horse-battery' },
]

test('finding 24: secrets never reach state.json or events.jsonl', async () => {
  for (const { text, secret } of SECRETS) {
    const root = makeRepo()
    await advanceTo(root, 'feat', 'worktree')
    await state(root, ['start-slice', 'feat', 'S1'])
    await state(root, ['finish-slice', 'feat', 'S1', '--verification', text, '--note', text])
    await state(root, ['start-slice', 'feat', 'S2'])
    await state(root, ['finish-slice', 'feat', 'S2', '--verification', 'mvn test'])
    await state(root, ['verification', 'feat', 'pass', '--command', text, '--exit', '0', '--summary', text])
    await state(root, ['drift', 'feat', '--target', 'design', '--reason', text])
    for (const file of ['.dex/feat/state.json', '.dex/feat/events.jsonl']) {
      assert.doesNotMatch(read(root, file), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${file}: ${text}`)
    }
  }
})

test('finding 24: secrets are scrubbed before long text is cut short', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'worktree')
  await finished(root)
  // Stored commands are cut at 400 characters. Place the token so that the cut
  // keeps its first 7 characters: too short for a pattern that needs 8 or more.
  const token = 'ghp_' + 'Z'.repeat(36)
  const lead = ' Authorization: token '
  const command = 'x'.repeat(400 - lead.length - 7) + lead + token
  await state(root, ['verification', 'feat', 'pass', '--command', command, '--exit', '0'])
  for (const file of ['.dex/feat/state.json', '.dex/feat/events.jsonl']) {
    assert.doesNotMatch(read(root, file), /ghp_/, file)
  }
})

// ---------------------------------------------------------------------------
// Slugs (findings 25, 33, 34)
// ---------------------------------------------------------------------------

test('finding 25: invalid slugs are refused before any folder is touched', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'init')
  for (const bad of ['../escaped', 'Foo', 'a/b', 'x'.repeat(61), '-lead']) {
    for (const argv of [['approve', 'design', bad], ['status', bad], ['active', bad], ['start-slice', bad, 'S1']]) {
      assert.match(await stateFails(root, argv), /not a valid feature name/, argv.join(' '))
    }
  }
  // `.dex/../escaped` would land next to the feature folders; `../escaped` from
  // the state root would land in the repository root.
  assert.equal(fs.existsSync(path.join(root, 'escaped')), false)
  assert.equal(fs.existsSync(path.join(root, '.dex', 'escaped')), false)
  assert.deepEqual(fs.readdirSync(path.join(root, '.dex')).sort(), ['active', 'config.json', 'feat'])
})

test('finding 33: a title with no ASCII letters is refused instead of becoming "feature"', async () => {
  const root = makeRepo()
  const msg = await stateFails(root, ['init', '日本語'])
  assert.match(msg, /slug/)
  assert.equal(fs.existsSync(path.join(root, '.dex/feature')), false)
})

test('finding 29: gate names cannot be feature names', async () => {
  const root = makeRepo()
  for (const gate of ['code', 'design', 'questions', 'structure']) {
    assert.match(await stateFails(root, ['init', gate]), /reserved/, gate)
  }
})

test('finding 29: approve takes <gate> <slug>, in that order only', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  const msg = await stateFails(root, ['approve', 'feat', 'questions'])
  assert.match(msg, /approve <gate> <slug>/)
  await state(root, ['approve', 'questions', 'feat'])
})

// ---------------------------------------------------------------------------
// Locks (finding 28)
// ---------------------------------------------------------------------------

function lockAt(root, content, ageMs) {
  const lock = path.join(root, '.dex/feat/.lock')
  fs.writeFileSync(lock, content)
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(lock, t, t)
  return lock
}

test('finding 28: a fresh, empty lock is respected', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  lockAt(root, '', 0)
  assert.match(await stateFails(root, ['approve', 'questions', 'feat']), /locked/)
})

test('finding 28: an old, empty lock is reclaimed', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  lockAt(root, '', 5 * 60_000)
  await state(root, ['approve', 'questions', 'feat'])
})

test('finding 28: a lock stamped in the future is reclaimed', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'questions')
  lockAt(root, JSON.stringify({ pid: 1, acquiredAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() }), 0)
  await state(root, ['approve', 'questions', 'feat'])
})

function runCli(cwd, argv) {
  return new Promise((resolve) => {
    const p = spawn('node', [STATE_CLI, ...argv], { cwd })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
}

test('finding 28: two init commands at once create the feature exactly once', async () => {
  for (let n = 0; n < 20; n++) {
    const root = makeRepo()
    const results = await Promise.all([runCli(root, ['init', 'feat', '--title', 'A']), runCli(root, ['init', 'feat', '--title', 'B'])])
    const created = results.filter((r) => /Initialized feature/.test(r.out))
    assert.equal(created.length, 1, results.map((r) => r.out).join('\n---\n'))
  }
})

// ---------------------------------------------------------------------------
// Doctor (findings 31, 32)
// ---------------------------------------------------------------------------

test('finding 31: doctor writes only its staged workflow copies into the repository', async () => {
  const root = makeRepo()
  await runDoctor({ cwd: root })
  assert.deepEqual(fs.readdirSync(path.join(root, '.dex')), ['_workflows'])
  assert.deepEqual(fs.readdirSync(path.join(root, '.dex', '_workflows')).sort(), ['research.js', 'review.js'])
  assert.equal(fs.existsSync(path.join(root, 'docs')), false)
  assert.equal(gitIn(root, ['status', '--porcelain']).trim(), '')
})

test('doctor passes the workflow staging checks in a normal repository', async () => {
  const root = makeRepo()
  const result = await runDoctor({ cwd: root })
  for (const name of ['research', 'review']) {
    const line = result.checks.find((c) => c.name === `Workflow ${name} staging`)
    assert.equal(line.status, 'PASS', `${name}: ${line.detail}`)
  }
})

test('doctor stages into the linked worktree it runs from, and passes', async () => {
  const root = makeRepo()
  const wt = fs.mkdtempSync(path.join(path.dirname(root), 'dex-wt-'))
  fs.rmdirSync(wt)
  gitIn(root, ['worktree', 'add', '-q', wt, '-b', 'wt-branch'])
  try {
    const result = await runDoctor({ cwd: wt })
    for (const name of ['research', 'review']) {
      const line = result.checks.find((c) => c.name === `Workflow ${name} staging`)
      assert.equal(line.status, 'PASS', `${name}: ${line.detail}`)
      assert.ok(fs.existsSync(path.join(wt, '.dex', '_workflows', `${name}.js`)), name)
    }
  } finally {
    gitIn(root, ['worktree', 'remove', '--force', wt])
  }
})

test('doctor fails when the state folder is a symlink to somewhere outside the checkout', async () => {
  const root = makeRepo()
  const outside = fs.mkdtempSync(path.join(path.dirname(root), 'dex-outside-'))
  fs.symlinkSync(outside, path.join(root, '.dex'))
  try {
    const result = await runDoctor({ cwd: root })
    assert.equal(result.ok, false)
    for (const name of ['research', 'review']) {
      const line = result.checks.find((c) => c.name === `Workflow ${name} staging`)
      assert.equal(line.status, 'FAIL', `${name}: ${line.detail}`)
      assert.match(line.detail, /outside/)
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('doctor fails when the workflows cannot be staged', async () => {
  const root = makeRepo()
  write(root, '.dex', 'not a folder')
  const result = await runDoctor({ cwd: root })
  assert.equal(result.ok, false)
  for (const name of ['research', 'review']) {
    const line = result.checks.find((c) => c.name === `Workflow ${name} staging`)
    assert.equal(line.status, 'FAIL', name)
    assert.match(line.detail, /could not copy/)
  }
})

test('finding 32: doctor reports a feature it cannot read, and fails', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat', 'init')
  write(root, '.dex/feat/state.json', '{ "schemaVersion": 1, ')
  const result = await runDoctor({ cwd: root })
  assert.equal(result.ok, false)
  const line = result.checks.find((c) => c.name === 'Features')
  assert.match(line.detail, /feat/)
  assert.match(line.detail, /cannot be read|could not read/i)
})

// ---------------------------------------------------------------------------
// The config file has one home (finding 38)
// ---------------------------------------------------------------------------

test('finding 38: with a custom stateRoot, the config stays in .dex/config.json', async () => {
  const root = makeRepo()
  write(root, '.dex/config.json', JSON.stringify({ schemaVersion: 1, stateRoot: '.dex-state' }))
  await state(root, ['init', 'feat', '--title', 'Feat'])
  assert.ok(fs.existsSync(path.join(root, '.dex-state/feat/state.json')))
  assert.equal(fs.existsSync(path.join(root, '.dex-state/config.json')), false, 'no second config file')
})
