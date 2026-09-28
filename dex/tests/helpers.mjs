/**
 * Test helpers: build a throwaway git repository per test so nothing here ever
 * touches the real working tree.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const STATE_CLI = path.join(PLUGIN_ROOT, 'scripts', 'state.mjs')

const created = []

/** A temporary git repository with one commit and one source file. */
export function makeRepo({ git: withGit = true, files = {} } = {}) {
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
