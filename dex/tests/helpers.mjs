/**
 * Test helpers: build a throwaway git repository per test so nothing here ever
 * touches the real working tree.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const STATE_CLI = path.join(PLUGIN_ROOT, 'scripts', 'state.mjs')

const created = []

/**
 * A temporary git repository with one commit and one source file.
 * With `origin: true` it also gets a bare repository as `origin`, with `main` pushed.
 */
export function makeRepo({ git: withGit = true, files = {}, origin = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-test-'))
  created.push(root)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'PortfolioService.java'), 'class PortfolioService {}\n')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  if (withGit) {
    const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 'test@example.invalid'])
    run(['config', 'user.name', 'Dex Test'])
    run(['config', 'commit.gpgsign', 'false'])
    run(['add', '-A'])
    run(['commit', '-qm', 'initial'])
    if (origin) {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-origin-'))
      created.push(bare)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare, stdio: 'ignore' })
      run(['remote', 'add', 'origin', bare])
      run(['push', '-q', '-u', 'origin', 'main'])
    }
  }
  return root
}

export function cleanupRepos() {
  for (const root of created.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/** Invoke the state CLI in-process so assertions can read its structured result. */
export async function state(root, argv) {
  const mod = await import(`file://${STATE_CLI}`)
  return mod.run(argv, { cwd: root })
}

/** Invoke the state CLI and expect it to throw, returning the message. */
export async function stateFails(root, argv) {
  try {
    await state(root, argv)
  } catch (err) {
    return err.message
  }
  throw new Error(`expected "${argv.join(' ')}" to fail, but it succeeded`)
}

export function write(root, rel, content) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

export function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

export function exists(root, rel) {
  return fs.existsSync(path.join(root, rel))
}

export function readState(root, slug) {
  return JSON.parse(read(root, `.dex/${slug}/state.json`))
}

export function events(root, slug) {
  const p = path.join(root, '.dex', slug, 'events.jsonl')
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

export function gitIn(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const A = 'docs/dex'

/**
 * Drive a feature to a named lifecycle point so gate tests can start from there.
 * Every step goes through the real CLI — no hand-written state.
 */
export async function advanceTo(root, slug, target) {
  const order = ['init', 'questions', 'questions-approved', 'research', 'design', 'design-approved', 'structure', 'structure-approved', 'slices', 'plan', 'worktree']
  const stop = order.indexOf(target)
  if (stop === -1) throw new Error(`unknown target "${target}"`)
  const d = `${A}/${slug}`

  await state(root, ['init', slug, '--title', 'Portfolio optimization'])
  if (stop === 0) return {}
  write(root, `${d}/01-intent.md`, '# Feature Intent\n\nProblem: optimization is manual.\n')

  if (stop >= 1) write(root, `${d}/02-questions.md`, '# Research Questions\n\n1. Where does creation enter?\n')
  if (stop >= 2) await state(root, ['approve', slug, 'questions'])
  if (stop >= 3) write(root, `${d}/03-research.md`, '# Codebase Research\n\nFACT: src/PortfolioService.java:1-1\n')
  if (stop >= 4) write(root, `${d}/04-design.md`, '# Design\n\nUse PortfolioService.\n')
  if (stop >= 5) await state(root, ['approve', slug, 'design'])
  if (stop >= 6) write(root, `${d}/05-structure.md`, '# Program Structure\n\nTracer bullet required: NO\n')
  if (stop >= 7) await state(root, ['approve', slug, 'structure'])
  if (stop >= 8) await state(root, ['set-slices', slug, 'S1:tracer — end to end', 'S2:happy path'])
  if (stop >= 9) write(root, `${d}/06-plan.md`, '# Tactical Plan\n\n## Checkpoint S1\n')

  let worktree = null
  if (stop >= 10) {
    worktree = path.join(path.dirname(root), `${path.basename(root)}-wt`)
    gitIn(root, ['worktree', 'add', '-q', worktree, '-b', `dex/${slug}`])
    created.push(worktree)
    await state(root, ['record-worktree', slug, `dex/${slug}`, worktree, '--base', 'main'])
  }
  return { worktree }
}

/** Complete both checkpoints, verification, and AI review — everything but the human. */
export async function completeImplementation(root, slug, worktree) {
  fs.appendFileSync(path.join(worktree, 'src', 'PortfolioService.java'), '// optimization\n')
  write(worktree, 'src/Optimizer.java', 'class Optimizer {}\n')
  for (const id of ['S1', 'S2']) {
    await state(root, ['start-slice', slug, id])
    await state(root, ['finish-slice', slug, id, '--verification', 'mvn -q test'])
  }
  await state(root, ['verification', slug, 'pass', '--command', 'mvn -q test', '--exit', '0'])
  await state(root, ['record-review', slug, 'pass', '--blockers', '0'])
}

// ---------------------------------------------------------------------------
// Hooks, run as real processes
// ---------------------------------------------------------------------------

/**
 * Run a hook script exactly as Claude Code would: payload as JSON on stdin,
 * working directory taken from the payload. Returns the exit status, raw
 * output, and the parsed JSON output when there is any.
 */
export function runHook(script, payload) {
  const res = spawnSync('node', [path.join(PLUGIN_ROOT, 'scripts', script)], {
    cwd: payload.cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  let json = null
  if (res.stdout.trim()) {
    try {
      json = JSON.parse(res.stdout)
    } catch {
      /* plain-text output; callers read stdout */
    }
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json }
}

/**
 * Run the PreToolUse guard. `payload` needs `cwd`, `tool_name` and `tool_input`.
 * Returns { decision: 'allow' | 'deny' | 'ask', reason }.
 */
export function runGuard(payload) {
  const out = runHook('guard.mjs', { hook_event_name: 'PreToolUse', ...payload })
  const hso = out.json?.hookSpecificOutput
  if (!hso) return { decision: 'allow', reason: null }
  return { decision: hso.permissionDecision, reason: hso.permissionDecisionReason }
}

/** Shorthand: run a Bash command through the guard from `cwd`. */
export function guardBash(cwd, command) {
  return runGuard({ cwd, tool_name: 'Bash', tool_input: { command } })
}

/** Run the UserPromptSubmit approval hook (added in step 2) for a typed prompt. */
export function runPromptHook(prompt, cwd) {
  return runHook('approve-hook.mjs', { hook_event_name: 'UserPromptSubmit', cwd, prompt })
}

// ---------------------------------------------------------------------------
// Workflows, run in Node with a fake agent
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/**
 * Run a workflow script outside Claude Code. The Workflow tool's globals are
 * replaced with fakes that follow its documented behaviour:
 *   - agent() returns null when the agent fails (here: when fakeAgent throws)
 *   - parallel() never rejects; a failed thunk becomes null
 *   - pipeline() passes (prevResult, item, index) to each stage; a throwing
 *     stage turns that item into null
 *   - at most `concurrency` agents run at once (the real cap is at most 16)
 *
 * `fakeAgent(prompt, opts)` returns the agent's answer. Every call is recorded.
 */
export async function runWorkflow(file, args, fakeAgent, { concurrency = 16 } = {}) {
  const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'workflows', file), 'utf8')
  const body = src.replace(/^export const meta\s*=/m, 'const meta =')

  const calls = []
  const logs = []
  const phases = []
  let inFlight = 0
  let maxInFlight = 0
  const waiting = []

  async function agent(prompt, opts = {}) {
    calls.push({ prompt, opts })
    if (inFlight >= concurrency) await new Promise((resolve) => waiting.push(resolve))
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await new Promise((resolve) => setImmediate(resolve))
      const answer = await fakeAgent(prompt, opts)
      return answer ?? null
    } catch {
      return null
    } finally {
      inFlight--
      waiting.shift()?.()
    }
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, index) => {
        let value = item
        try {
          for (const stage of stages) value = await stage(value, item, index)
          return value
        } catch {
          return null
        }
      })
    )
  const phase = (title) => phases.push(title)
  const log = (message) => logs.push(message)
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }

  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', body)
  const result = await fn(agent, parallel, pipeline, phase, log, args, budget)
  return { result, calls, logs, phases, maxInFlight }
}

// ---------------------------------------------------------------------------
// Plugin files, read as text
// ---------------------------------------------------------------------------

/**
 * Read plugin files matching a simple glob relative to the plugin root.
 * `*` matches one path segment, `**` any number of segments.
 * Returns [{ rel, text }] sorted by path.
 */
export function staticText(glob) {
  const parts = glob.split('/')
  const out = []
  function walk(dir, i) {
    if (i === parts.length) return
    const part = parts[i]
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []
    if (part === '**') {
      walk(dir, i + 1)
      for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), i)
      return
    }
    const re = new RegExp('^' + part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
    for (const e of entries) {
      if (!re.test(e.name)) continue
      const abs = path.join(dir, e.name)
      if (i === parts.length - 1) {
        if (e.isFile()) out.push({ rel: path.relative(PLUGIN_ROOT, abs), text: fs.readFileSync(abs, 'utf8') })
      } else if (e.isDirectory()) {
        walk(abs, i + 1)
      }
    }
  }
  walk(PLUGIN_ROOT, 0)
  return [...new Map(out.map((f) => [f.rel, f])).values()].sort((a, b) => a.rel.localeCompare(b.rel))
}
