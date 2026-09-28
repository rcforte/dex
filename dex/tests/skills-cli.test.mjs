/**
 * Skills and workflows tell Claude to run state.mjs with particular commands,
 * flags and transition names. If one of those drifts from what state.mjs
 * actually accepts, the failure only shows up in a live session. This test
 * catches it here instead.
 *
 * What state.mjs accepts is read from its source: the COMMANDS table, the
 * flags each command reads, and the TRANSITIONS table.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { PLUGIN_ROOT, staticText } from './helpers.mjs'

const STATE_SRC = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'state.mjs'), 'utf8')

/** Command name -> set of flags that command's handler reads. */
function knownCommands(src) {
  const commands = new Map()
  const re = /^COMMANDS(?:\.([a-z]+)|\['([a-z-]+)'\])\s*=/gm
  const starts = [...src.matchAll(re)].map((m) => ({ name: m[1] || m[2], index: m.index }))
  starts.forEach((c, i) => {
    const body = src.slice(c.index, i + 1 < starts.length ? starts[i + 1].index : src.length)
    const flags = new Set()
    for (const m of body.matchAll(/flags\.([a-zA-Z]+)|flags\['([a-z-]+)'\]/g)) flags.add(m[1] || m[2])
    commands.set(c.name, flags)
  })
  return commands
}

function knownTransitions(src) {
  const start = src.indexOf('const TRANSITIONS = {')
  const end = src.indexOf('\n}\n', start)
  return new Set([...src.slice(start, end).matchAll(/^\s+'([a-z-]+)':/gm)].map((m) => m[1]))
}

/** Every `state.mjs <command> ...` invocation in skills and workflows. */
function invocations() {
  const files = [...staticText('skills/*/SKILL.md'), ...staticText('workflows/*.js')]
  const found = []
  for (const { rel, text } of files) {
    // Join shell line continuations so flags on the next line are seen.
    const joined = text.replace(/\\\n\s*/g, ' ')
    for (const m of joined.matchAll(/state\.mjs"?\s+([a-z][a-z-]*)([^\n`]*)/g)) {
      const words = m[2].trim().split(/\s+/)
      found.push({
        rel,
        command: m[1],
        flags: [...m[2].matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map((f) => f[1]),
        // `transition <slug> <event>`: the event is the second word.
        event: m[1] === 'transition' ? words[1] : null,
        line: m[0].trim(),
      })
    }
  }
  return found
}

const COMMANDS = knownCommands(STATE_SRC)
const TRANSITIONS = knownTransitions(STATE_SRC)
const CALLS = invocations()

test('the source scan finds the state.mjs commands and transitions', () => {
  assert.ok(COMMANDS.size >= 20, `found only ${COMMANDS.size} commands`)
  assert.ok(COMMANDS.get('finish-slice').has('verification'))
  assert.ok(COMMANDS.get('verification').has('commands-json'))
  assert.ok(TRANSITIONS.has('questions-generated'))
  assert.ok(CALLS.length >= 20, `found only ${CALLS.length} invocations`)
})

test('every state.mjs command used by a skill or workflow exists', () => {
  const unknown = CALLS.filter((c) => !COMMANDS.has(c.command)).map((c) => `${c.rel}: ${c.line}`)
  assert.deepEqual(unknown, [])
})

test('every flag passed to state.mjs is one that command reads', () => {
  const unknown = CALLS.flatMap((c) =>
    c.flags.filter((f) => COMMANDS.has(c.command) && !COMMANDS.get(c.command).has(f)).map((f) => `${c.rel}: ${c.command} --${f}`)
  )
  assert.deepEqual(unknown, [])
})

test('every transition event used by a skill exists', () => {
  const unknown = CALLS.filter((c) => c.event && !c.event.startsWith('<') && !TRANSITIONS.has(c.event)).map((c) => `${c.rel}: ${c.line}`)
  assert.deepEqual(unknown, [])
})
