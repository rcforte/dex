#!/usr/bin/env node
/**
 * dex/scripts/doctor.mjs
 *
 * Environment and installation check. Answers one question: can this repository
 * run Dex right now, and if not, what exactly is missing?
 *
 * Usage: node doctor.mjs [--json]
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG,
  findRepoRoot,
  prePushStatus,
  isGitRepo,
  scanFeatures,
  loadConfig,
  normalizeRelPath,
  pad,
  sessionTop,
  stageWorkflow,
  WORKFLOW_NAMES,
} from './lib.mjs'

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PASS = 'PASS'
const FAIL = 'FAIL'
const WARN = 'WARN'

function which(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = execFileSync(probe, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/)[0].trim() || null
  } catch {
    return null
  }
}

function tryVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]
  } catch {
    return null
  }
}

/** Can this directory be written to? Tested by actually writing, not by stat. */
/**
 * Whether Dex could create and write `dir`. Looks without writing: checks the
 * folder, or its nearest existing parent, for write permission.
 */
function writableDir(dir) {
  let probe = path.resolve(dir)
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return false
    probe = parent
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK)
    return fs.statSync(probe).isDirectory()
  } catch {
    return false
  }
}

/** Parse a workflow file far enough to confirm it exports a usable meta block. */
async function checkWorkflow(file) {
  const abs = path.join(PLUGIN_ROOT, 'workflows', file)
  if (!fs.existsSync(abs)) return { status: FAIL, detail: `${file} is missing` }
  const src = fs.readFileSync(abs, 'utf8')
  const m = src.match(/export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/)
  if (!m) return { status: FAIL, detail: `${file} does not export a meta block` }
  if (!/name\s*:/.test(m[1])) return { status: FAIL, detail: `${file} meta has no name` }
  if (!/description\s*:/.test(m[1])) return { status: FAIL, detail: `${file} meta has no description` }
  // Workflow scripts use an injected runtime (agent/parallel/pipeline/phase),
  // contain a top-level return, and use top-level await, so they cannot be
  // imported. Compile the source as an async function body, which is how the
  // workflow runtime evaluates it.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  try {
    new AsyncFunction(src.replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta ='))
  } catch (err) {
    return { status: FAIL, detail: `${file} does not parse: ${err.message}` }
  }
  return { status: PASS, detail: `${file} exports meta and parses` }
}

export async function runDoctor({ cwd = process.cwd() } = {}) {
  const checks = []
  const add = (name, status, detail) => checks.push({ name, status, detail })

  // --- Runtime ------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0])
  add('Node', major >= 18 ? PASS : FAIL, major >= 18 ? `${process.version}` : `${process.version} — Dex requires Node >= 18`)

  const claudePath = which('claude')
  const claudeVersion = claudePath ? tryVersion('claude', ['--version']) : null
  add('Claude Code', claudePath ? PASS : WARN, claudePath ? `${claudeVersion ?? 'installed'}` : 'not on PATH (Dex still works inside a Claude Code session)')

  const gitPath = which('git')
  add('Git', gitPath ? PASS : FAIL, gitPath ? `${tryVersion('git', ['--version'])}` : 'not found — Dex binds code approval to a git diff hash')

  const ghPath = which('gh')
  add('GitHub CLI', ghPath ? PASS : WARN, ghPath ? `${tryVersion('gh', ['--version'])}` : 'not found — /dex:pr will print the PR body instead of creating it')

  // --- Plugin -------------------------------------------------------------
  const manifestPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
  let manifest = null
  if (!fs.existsSync(manifestPath)) {
    add('Plugin manifest', FAIL, `not found at ${manifestPath}`)
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      add('Plugin manifest', manifest.name === 'dex' ? PASS : FAIL, `${manifest.name} v${manifest.version}`)
    } catch (err) {
      add('Plugin manifest', FAIL, `invalid JSON: ${err.message}`)
    }
  }

  const expectedSkills = [
    'start', 'questions', 'research', 'design', 'structure', 'plan', 'worktree',
    'implement', 'verify', 'review', 'approve', 'status', 'next', 'resume', 'pr', 'doctor',
  ]
  const missingSkills = expectedSkills.filter((s) => !fs.existsSync(path.join(PLUGIN_ROOT, 'skills', s, 'SKILL.md')))
  add('Skills', missingSkills.length ? FAIL : PASS, missingSkills.length ? `missing: ${missingSkills.join(', ')}` : `${expectedSkills.length} stage skills present`)

  const expectedAgents = ['research-probe', 'research-verifier', 'implementation-reviewer', 'verification-analyzer']
  const missingAgents = expectedAgents.filter((a) => !fs.existsSync(path.join(PLUGIN_ROOT, 'agents', `${a}.md`)))
  add('Agents', missingAgents.length ? FAIL : PASS, missingAgents.length ? `missing: ${missingAgents.join(', ')}` : `${expectedAgents.length} agents present`)

  const hooksPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')
  if (!fs.existsSync(hooksPath)) {
    add('Hooks', FAIL, 'hooks/hooks.json is missing — nothing enforces the gates')
  } else {
    try {
      const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'))
      const pre = hooks?.hooks?.PreToolUse
      add('Hooks', Array.isArray(pre) && pre.length ? PASS : FAIL, Array.isArray(pre) && pre.length ? `PreToolUse guard registered (${pre[0].matcher})` : 'no PreToolUse entry')
      const prompt = (hooks?.hooks?.UserPromptSubmit || []).flatMap((h) => h.hooks || [])
      const approveHook = prompt.some((h) => String(h.command).includes('approve-hook.mjs'))
      add('Hooks', approveHook ? PASS : FAIL, approveHook ? 'UserPromptSubmit approval hook registered' : 'no UserPromptSubmit approval hook — /dex:approve cannot record approvals')
    } catch (err) {
      add('Hooks', FAIL, `hooks.json invalid: ${err.message}`)
    }
  }

  const selfFile = path.basename(fileURLToPath(import.meta.url))
  for (const script of ['lib.mjs', 'shell.mjs', 'commands.mjs', 'state.mjs', 'guard.mjs', 'approve-hook.mjs', 'pre-push.mjs', 'doctor.mjs', 'status.mjs']) {
    const abs = path.join(PLUGIN_ROOT, 'scripts', script)
    if (!fs.existsSync(abs)) {
      add(`Script ${script}`, FAIL, 'missing')
      continue
    }
    if (script === selfFile) {
      // This module is mid-execution. Importing it would deadlock on its own
      // top-level await, and it has obviously loaded already.
      add(`Script ${script}`, PASS, 'loads (running)')
      continue
    }
    try {
      await import(`file://${abs}`)
      add(`Script ${script}`, PASS, 'loads')
    } catch (err) {
      add(`Script ${script}`, FAIL, `does not load: ${err.message}`)
    }
  }

  for (const name of WORKFLOW_NAMES) {
    const r = await checkWorkflow(`${name}.js`)
    add(`Workflow ${name}.js`, r.status, r.detail)
  }

  const templateFiles = [
    'intent.md', 'questions.md', 'research.md', 'design.md', 'structure.md',
    'plan.md', 'implementation-log.md', 'review.md', 'pr.md',
  ]
  const missingTemplates = templateFiles.filter((t) => !fs.existsSync(path.join(PLUGIN_ROOT, 'templates', t)))
  add('Templates', missingTemplates.length ? FAIL : PASS, missingTemplates.length ? `missing: ${missingTemplates.join(', ')}` : `${templateFiles.length} templates present`)

  // --- Repository ---------------------------------------------------------
  const root = findRepoRoot(cwd)
  const repo = isGitRepo(root)
  add('Repository', repo ? PASS : WARN, repo ? normalizeRelPath(root, path.dirname(root)) || root : `${root} is not a git repository — the human code approval gate cannot bind to a diff`)

  let config
  try {
    config = loadConfig(root)
    const label = config.__exists ? normalizeRelPath(config.__path, root) : 'using built-in defaults'
    add('Config', config.__warnings?.length ? WARN : PASS, config.__warnings?.length ? `${label}: ${config.__warnings.join('; ')}` : label)
  } catch (err) {
    config = { ...DEFAULT_CONFIG }
    add('Config', FAIL, err.message.split('\n')[0])
  }

  if (repo) {
    const hook = prePushStatus(root)
    add(
      'Pre-push hook',
      hook.installed ? PASS : WARN,
      hook.installed
        ? `installed (${hook.file})`
        : `not installed: ${hook.reason}. /dex:worktree installs it; or run: node ${path.join(PLUGIN_ROOT, 'scripts', 'state.mjs')} install-hook`
    )
  }

  const stateRoot = path.join(root, config.stateRoot)
  add('State root writable', writableDir(stateRoot) ? PASS : FAIL, stateRoot)
  const artifactRoot = path.join(root, config.artifactRoot)
  add('Artifact root writable', writableDir(artifactRoot) ? PASS : FAIL, artifactRoot)

  // The Workflow tool only loads scripts from inside the project, so skills
  // launch a staged copy. Stage for real: a folder that looks writable can
  // still refuse the copy. Compare real paths, so a symlinked state folder
  // that points outside the checkout is caught.
  const top = sessionTop(cwd, root)
  for (const name of WORKFLOW_NAMES) {
    try {
      const { path: staged } = stageWorkflow(root, config, name, { cwd })
      const rel = path.relative(fs.realpathSync(top), fs.realpathSync(staged))
      const inside = rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
      add(`Workflow ${name} staging`, inside ? PASS : FAIL, inside ? rel : `${staged} is outside ${top} — the Workflow tool would refuse it`)
    } catch (err) {
      add(`Workflow ${name} staging`, FAIL, err.message.split('\n')[0])
    }
  }

  try {
    const { features, unreadable } = scanFeatures(root, config)
    const listed = features.map((f) => `${f.slug} (${f.phase})`)
    if (unreadable.length) {
      add(
        'Features',
        FAIL,
        `cannot be read: ${unreadable.map((u) => `${u.slug} (${u.error})`).join(', ')}. The guard refuses changes until this is fixed.` +
          (listed.length ? ` Readable: ${listed.join(', ')}` : '')
      )
    } else {
      add('Features', PASS, listed.length ? listed.join(', ') : 'none yet — start with /dex:start')
    }
  } catch (err) {
    add('Features', FAIL, err.message.split('\n')[0])
  }

  const failed = checks.filter((c) => c.status === FAIL)
  const warned = checks.filter((c) => c.status === WARN)

  const width = Math.max(...checks.map((c) => c.name.length)) + 2
  const lines = ['DEX DOCTOR', '']
  for (const c of checks) lines.push(`${pad(c.name, width)}${pad(c.status, 6)}${c.detail}`)
  lines.push('')
  if (failed.length) {
    lines.push(`NOT READY — ${failed.length} check(s) failed:`)
    for (const c of failed) lines.push(`  - ${c.name}: ${c.detail}`)
  } else if (warned.length) {
    lines.push(`Ready, with ${warned.length} warning(s).`)
  } else {
    lines.push('Ready.')
  }
  lines.push('')
  lines.push(`Plugin root: ${PLUGIN_ROOT}`)
  lines.push(`Platform:    ${os.platform()} ${os.release()}`)

  return { ok: failed.length === 0, checks, text: lines.join('\n') }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
if (isMain) {
  const result = await runDoctor()
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ ok: result.ok, checks: result.checks }, null, 2) + '\n')
  } else {
    process.stdout.write(result.text + '\n')
  }
  process.exit(result.ok ? 0 : 1)
}
