/**
 * Step 8: the documentation matches the plugin.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { PLUGIN_ROOT, staticText } from './helpers.mjs'
import { run as stateRun } from '../scripts/state.mjs'

const README = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8')

/** The text of one `## Heading` section of the README. */
function section(title) {
  const start = README.indexOf(`\n## ${title}\n`)
  assert.ok(start !== -1, `README has a "${title}" section`)
  const end = README.indexOf('\n## ', start + 4)
  return README.slice(start, end === -1 ? README.length : end)
}

test('the README command table lists every skill, and nothing else', () => {
  const skills = fs.readdirSync(path.join(PLUGIN_ROOT, 'skills')).sort()
  const listed = [...new Set([...section('Commands').matchAll(/`\/dex:([a-z]+)/g)].map((m) => m[1]))].sort()
  assert.deepEqual(listed, skills)
})

test('the README documents every state.mjs command', () => {
  const commands = stateRun(['help']).json.commands
  const cli = section('Command-line tool')
  const missing = commands.filter((c) => !cli.includes(`\`${c}`))
  assert.deepEqual(missing, [])
})

test('the plugin version matches the newest CHANGELOG entry', () => {
  const version = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version
  const newest = /^## \[(\d+\.\d+\.\d+)\]/m.exec(fs.readFileSync(path.join(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8'))?.[1]
  assert.equal(version, newest)
})

test('the README no longer describes behaviour that was removed', () => {
  assert.doesNotMatch(README, /bound to a diff hash/)
  assert.doesNotMatch(README, /Writes to `docs\/dex\/\*\*` and `\.dex\/\*\*`\s+stay allowed/)
  assert.match(section('What is enforced deterministically'), /pre-push/)
})

const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' })
test('the plugin passes strict validation', { skip: claude.status !== 0 && 'claude CLI not on PATH' }, () => {
  const out = spawnSync('claude', ['plugin', 'validate', '--strict', PLUGIN_ROOT], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stdout + out.stderr)
})

test('skills name only state.mjs commands that the README documents', () => {
  const cli = section('Command-line tool')
  for (const { rel, text } of staticText('skills/*/SKILL.md')) {
    for (const m of text.matchAll(/state\.mjs"?\s+([a-z][a-z-]*)/g)) assert.ok(cli.includes(`\`${m[1]}`), `${rel}: ${m[1]}`)
  }
})
