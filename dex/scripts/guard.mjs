#!/usr/bin/env node
/**
 * dex/scripts/guard.mjs
 *
 * PreToolUse enforcement.
 *
 * Why this exists: an instruction like "do not implement until the design is
 * approved" is a request a model can forget. This file is a program that cannot.
 * It reads the tool call Claude Code is about to make, reads the Dex state
 * machine, and refuses the call when a gate is not satisfied.
 *
 * What it refuses:
 *   1. Recording an approval, and writing to Dex's state folder, in every phase.
 *      Only the user approves (see approve-hook.mjs).
 *   2. Changing the repository before the implementation gates pass. Writes to
 *      the artifact folder are the exception.
 *   3. Publishing (push, PR, package upload) before every publish gate passes.
 *
 * Deliberate design choices:
 *   - No Dex feature means no gating at all. Dex must not hijack every coding
 *     task in the repository.
 *   - Shell commands are parsed (shell.mjs) and described (commands.mjs), not
 *     pattern-matched. A command Dex cannot see into, such as an inline script,
 *     counts as a change. Reading, testing and building are never refused.
 *   - A path is judged by where it really lands: `..` and symlinks are resolved,
 *     and relative paths start from the command's own directory.
 *   - When Dex cannot tell which gates apply (unreadable state, several active
 *     features, a crash), it refuses changes and publishing, and allows reading.
 *   - Pattern matching cannot stop every trick. The git pre-push hook
 *     (pre-push.mjs) backs up the publish gate for dex/* branches.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describeCommand } from './commands.mjs'
import { parseCommand, SUBST, unwrap } from './shell.mjs'
import {
  DEFAULT_CONFIG,
  findRepoRoot,
  isUnder,
  loadConfig,
  normalizeRelPath,
  resolveActiveFeature,
} from './lib.mjs'
import { computeGates, derivePhase, nextAction } from './state.mjs'

export const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch'])
export const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'PowerShell', 'Shell'])

/** An MCP tool whose name says it writes, moves or deletes something. */
function isMcpWrite(toolName) {
  if (!String(toolName).startsWith('mcp__')) return false
  const action = String(toolName).split('__').pop()
  return /write|edit|create|move|delete|remove|rename|patch|put|upload|append|mkdir|copy|save/i.test(action)
}

// ---------------------------------------------------------------------------
// Compatibility helpers (used by tests and older callers)
// ---------------------------------------------------------------------------

/** The simple commands in a command line, wrappers removed, one string each. */
export function splitSegments(command) {
  return parseCommand(command)
    .commands.map((c) => (unwrap(c.argv) ?? []).join(' ').replaceAll(SUBST, ''))
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Redirect targets that land in the repository outside the artifact and state folders. */
export function unsafeRedirectTargets(command, { artifactRoot, stateRoot, root, cwd = root, worktrees = [] }) {
  const where = { root, worktrees, config: { artifactRoot, stateRoot } }
  return describeCommand(command, { cwd, lookupAlias: () => null })
    .flatMap((c) => c.writes.map((t) => ({ t, loc: locate(t, c.cwd, where) })))
    .filter(({ loc }) => loc.where === 'repo' || loc.where === 'unknown')
    .map(({ t }) => t)
}

// ---------------------------------------------------------------------------
// Where a path lands
// ---------------------------------------------------------------------------

const WINDOWS_ABS = /^[A-Za-z]:[\\/]/

/** Resolve symlinks on the deepest part of the path that exists. */
function realpathish(p) {
  let head = p
  const tail = []
  for (let n = 0; n < 64; n++) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse())
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return p
      tail.push(path.basename(head))
      head = parent
    }
  }
  return p
}

/** Expand ~, $HOME and the temp-folder variables. Returns null when a variable is unknown. */
function expandPath(target) {
  let t = String(target)
  if (t.includes(SUBST)) return null
  t = t.replace(/^~(?=$|\/)/, process.env.HOME || '~')
  const tmp = process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir()
  const known = { TMPDIR: tmp, TEMP: tmp, TMP: tmp, HOME: process.env.HOME }
  let unknown = false
  t = t.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => {
    const v = known[name] ?? process.env[name]
    if (v === undefined) unknown = true
    return v ?? m
  })
  return unknown ? null : t
}

/**
 * Where a written path lands:
 *   state     the Dex state folder in the main checkout
 *   artifact  the artifact folder, in the main checkout or a feature worktree
 *   repo      anywhere else in the main checkout or a feature worktree
 *   outside   outside every checkout Dex knows about
 *   unknown   Dex cannot tell (an unset variable, a command substitution)
 */
export function locate(target, cwd, { root, worktrees = [], config }) {
  if (/^\/dev\//.test(target) || /^&\d*-?$/.test(target)) return { where: 'outside' }
  const t = expandPath(target)
  if (t === null) return { where: 'unknown', rel: target }

  if (WINDOWS_ABS.test(t) || WINDOWS_ABS.test(root)) {
    const rel = normalizeRelPath(path.win32.normalize(t), root)
    if (WINDOWS_ABS.test(rel)) return { where: 'outside' }
    return classify(rel, true, config)
  }

  const abs = realpathish(path.resolve(cwd || root, t))
  const bases = [...worktrees.map((w) => ({ dir: w, main: false })), { dir: root, main: true }]
  for (const { dir, main } of bases) {
    const base = realpathish(path.resolve(dir))
    if (abs === base || abs.startsWith(base + path.sep)) {
      return classify(path.relative(base, abs).split(path.sep).join('/'), main, config)
    }
  }
  return { where: 'outside' }
}

function classify(rel, main, config) {
  if (main && isUnder(rel, config.stateRoot)) return { where: 'state', rel }
  if (isUnder(rel, config.artifactRoot)) return { where: 'artifact', rel }
  return { where: 'repo', rel }
}

// ---------------------------------------------------------------------------
// What a tool call would do
// ---------------------------------------------------------------------------

/** Every filesystem path an edit-style tool call would write to. */
export function writeTargets(toolName, toolInput) {
  const input = toolInput || {}
  const out = []
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v)
  }
  push(input.file_path)
  push(input.filePath)
  push(input.notebook_path)
  push(input.notebookPath)
  push(input.path)
  push(input.target)
  push(input.destination)
  if (String(toolName).startsWith('mcp__')) push(input.source)
  if (Array.isArray(input.edits)) for (const e of input.edits) push(e?.file_path ?? e?.filePath)
  if (Array.isArray(input.files)) for (const f of input.files) push(typeof f === 'string' ? f : f?.file_path ?? f?.path)
  const patch = [input.patch, input.input].find((v) => typeof v === 'string')
  if (patch) {
    for (const m of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s*(.+?)\s*$/gm)) push(m[1])
  }
  return out
}

/**
 * The facts about one tool call, gathered once:
 *   approve   it runs `state.mjs approve`
 *   publish   what it publishes, or null
 *   edits     [{ target, loc }] for edit-style tools
 *   changes   [{ what, targets: [{ target, loc }] | null }] for shell commands
 *   writes    [{ target, loc }] for shell redirects
 */
function toolFacts({ toolName, toolInput, root, cwd, config, worktrees }) {
  const where = { root, worktrees, config }
  const facts = { approve: false, publish: null, edits: [], changes: [], writes: [] }
  if (EDIT_TOOLS.has(toolName) || isMcpWrite(toolName)) {
    facts.edits = writeTargets(toolName, toolInput).map((target) => ({ target, loc: locate(target, cwd, where) }))
    return facts
  }
  if (!SHELL_TOOLS.has(toolName)) return facts
  const command = String(toolInput?.command ?? toolInput?.script ?? '')
  for (const c of describeCommand(command, { cwd })) {
    if (c.approve) facts.approve = true
    if (c.publish && !facts.publish) facts.publish = c.publish
    if (c.change) {
      facts.changes.push({
        what: c.change.what,
        targets: c.change.paths ? c.change.paths.map((target) => ({ target, loc: locate(target, c.cwd, where) })) : null,
      })
    }
    for (const target of c.writes) facts.writes.push({ target, loc: locate(target, c.cwd, where) })
  }
  return facts
}

const inRepo = (loc) => loc.where === 'repo' || loc.where === 'unknown'

/** Everything the call would write into the Dex state folder. */
function stateWrites(facts) {
  const hits = [...facts.edits, ...facts.writes, ...facts.changes.flatMap((c) => c.targets ?? [])]
  return hits.filter((h) => h.loc.where === 'state').map((h) => h.target)
}

/** The first way this call would change the repository outside the artifact folder, if any. */
function repoChange(facts) {
  const edits = facts.edits.filter((e) => inRepo(e.loc))
  if (edits.length) return { kind: 'edit', targets: edits.map((e) => e.loc.rel ?? e.target) }
  for (const c of facts.changes) {
    if (!c.targets) return { kind: 'command', what: c.what }
    const hits = c.targets.filter((t) => inRepo(t.loc))
    if (hits.length) return { kind: 'command', what: c.what, targets: hits.map((t) => t.target) }
  }
  const writes = facts.writes.filter((w) => inRepo(w.loc))
  if (writes.length) return { kind: 'redirect', targets: writes.map((w) => w.target) }
  return null
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export const ALLOW = 'allow'
export const DENY = 'deny'

function denial(reason) {
  return { decision: DENY, reason }
}

const allow = (why) => ({ decision: ALLOW, why })

/**
 * The whole policy, as one pure function so it can be unit tested without
 * spawning Claude Code.
 *
 * @param {object} args
 * @param {string} args.toolName
 * @param {object} args.toolInput
 * @param {string} args.root          main checkout root
 * @param {string} [args.cwd]         the tool call's working directory (default: root)
 * @param {string[]} [args.worktrees] every feature worktree Dex knows about
 * @param {object} args.config        loaded Dex config
 * @param {object|null} args.feature  { slug, state, gates } or null
 * @param {boolean} args.ambiguous    several active features, none marked
 * @param {string[]} args.candidates
 * @param {string|null} args.lockdown why Dex cannot tell which gates apply
 */
export function decide({ toolName, toolInput, root, cwd = root, worktrees, config, feature, ambiguous = false, candidates = [], lockdown = null }) {
  const isEdit = EDIT_TOOLS.has(toolName) || isMcpWrite(toolName)
  const isShell = SHELL_TOOLS.has(toolName)
  if (!isEdit && !isShell) return allow('tool is not gated by Dex')

  const knownWorktrees = worktrees ?? [feature?.state?.worktree?.path].filter(Boolean)
  const facts = toolFacts({ toolName, toolInput, root, cwd, config, worktrees: knownWorktrees })

  // --- Human-only operations: refused in every phase, with or without a feature
  if (facts.approve) {
    return denial(
      `Dex refused to record an approval from a tool call. Only the user approves.\n\n` +
        `Ask the user to type:\n  /dex:approve <gate> <feature-slug>\n\n` +
        `or to run the approve command in their own terminal. Do not try another way.`
    )
  }
  const stateHits = stateWrites(facts)
  if (stateHits.length) {
    return denial(
      `Dex refused a write to its state folder (${config.stateRoot}/). That folder holds approvals and gate state, ` +
        `and only Dex's own state.mjs commands may change it.\n\n` +
        `Target(s):\n${stateHits.map((t) => `  - ${t}`).join('\n')}\n\n` +
        `Use the matching /dex:* command instead. If the state looks wrong, run /dex:status and tell the user.`
    )
  }

  // Several active features and none marked current, or state Dex cannot read:
  // Dex cannot tell which gates apply, so it refuses changes rather than guess.
  if (ambiguous && !lockdown) {
    lockdown =
      `several features are active and none is marked current:\n` +
      candidates.map((c) => `  - ${c}`).join('\n') +
      `\n\nDex will not guess which feature's gates apply.\n\nSelect one:\n  /dex:resume <feature>`
  }
  if (lockdown) return lockedDecision(facts, lockdown)

  if (!feature) return allow('no active Dex feature; Dex does not gate ordinary work')

  const { slug, state, gates } = feature
  // Derive the phase rather than trusting state.phase: the stored value is a
  // cached label that lags whenever an artifact is written without a CLI call.
  const phase = derivePhase(gates, state)

  // --- Publish gate: applies in every phase ------------------------------
  if (facts.publish) {
    // canPublish is only present when the gates were computed with tree checks.
    // Without it, Dex has not verified what would be pushed, so it refuses.
    const gate = gates.canPublish ?? { allowed: false, blockers: ['Dex did not check the code that would be pushed'] }
    if (gate.allowed) return allow('all publish gates satisfied')
    return denial(
      `Dex blocked ${facts.publish} for feature "${slug}".\n\n` +
        `Unsatisfied requirements:\n` +
        gate.blockers.map((b) => `  - ${b}`).join('\n') +
        `\n\n` +
        (gates.humanCodeReview.approved
          ? ''
          : `A human has to read the production diff. AI review and passing tests do not substitute for that.\n\n` +
            `  node <path-to-dex>/scripts/status.mjs ${slug} --review\n\n` +
            `Then:\n  /dex:approve code ${slug}\n\n`) +
        `Full state:\n  /dex:status ${slug}`
    )
  }

  // --- Everything below is only gated before implementation starts --------
  if (gates.canImplement.allowed) return allow('implementation gates satisfied')

  const change = repoChange(facts)
  if (!change) return allow('no repository change detected')

  const blockerList = gates.canImplement.blockers.map((b) => `  - ${b}`).join('\n')
  let nextCmd = null
  try {
    nextCmd = nextAction(root, config, state, gates).command
  } catch {
    // A malformed state must still produce a refusal, just a less specific one.
    nextCmd = null
  }
  const footer = `Next:\n  ${nextCmd ?? `/dex:status ${slug}`}`

  if (change.kind === 'edit') {
    return denial(
      `Dex blocked production code modification (${toolName}) for feature "${slug}".\n\n` +
        `Current phase: ${phase}\n` +
        `Blocked file(s):\n` +
        change.targets.map((t) => `  - ${t}`).join('\n') +
        `\n\nRequired before implementation:\n${blockerList}\n\n` +
        `Writes to ${config.artifactRoot}/** and ${config.stateRoot}/** are allowed right now.\n\n` +
        footer
    )
  }
  if (change.kind === 'command') {
    return denial(
      `Dex blocked ${change.what} for feature "${slug}" because implementation has not been unlocked.\n\n` +
        (change.targets ? `Affected path(s):\n${change.targets.map((t) => `  - ${t}`).join('\n')}\n\n` : '') +
        `Current phase: ${phase}\n` +
        `Required before implementation:\n${blockerList}\n\n` +
        `Read-only inspection (git status, git diff, git log, tests, builds) is allowed. ` +
        `So are changes inside ${config.artifactRoot}/.\n\n` +
        footer
    )
  }
  return denial(
    `Dex blocked a shell redirect that writes outside the Dex artifact directories for feature "${slug}".\n\n` +
      `Target(s):\n` +
      change.targets.map((t) => `  - ${t}`).join('\n') +
      `\n\nCurrent phase: ${phase}\n` +
      `Required before implementation:\n${blockerList}\n\n` +
      `Redirects to /dev/null, /tmp, ${config.artifactRoot}/** and ${config.stateRoot}/** are allowed. ` +
      `To keep a test or build log, write it to $TMPDIR instead.\n\n` +
      footer
  )
}

/**
 * The decision when Dex cannot tell which gates apply: reading and ordinary
 * inspection pass; changes and publishing are refused until the state is fixed.
 */
function lockedDecision(facts, lockdown) {
  const refuse = (what) =>
    denial(
      `Dex refused ${what} because ${lockdown}\n\n` +
        `Reading and inspecting are still allowed. Run /dex:doctor or /dex:status, and tell the user what is wrong.`
    )
  if (facts.publish) return refuse(facts.publish)
  const change = repoChange(facts)
  if (!change) return allow('no repository change detected')
  if (change.kind === 'command') return refuse(change.what)
  return refuse(`a write to ${change.targets.join(', ')}`)
}

// ---------------------------------------------------------------------------
// Hook plumbing
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** The feature whose recorded worktree contains any of these paths, if one does. */
function featureByWorktree(features, paths) {
  for (const f of features) {
    const wt = f.state.worktree?.path
    if (!wt || !fs.existsSync(wt)) continue
    const base = realpathish(wt)
    for (const p of paths) {
      const abs = realpathish(p)
      if (abs === base || abs.startsWith(base + path.sep)) return f
    }
  }
  return null
}

function isPublish(toolName, toolInput, cwd) {
  if (!SHELL_TOOLS.has(toolName)) return false
  return describeCommand(String(toolInput?.command ?? toolInput?.script ?? ''), { cwd }).some((c) => c.publish)
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0]
}

/** Build the decision inputs from a raw PreToolUse payload. */
export function evaluateHookInput(payload, { cwd = process.cwd() } = {}) {
  const toolName = payload?.tool_name ?? payload?.toolName ?? ''
  const toolInput = payload?.tool_input ?? payload?.toolInput ?? {}
  const startDir = payload?.cwd || cwd
  const root = findRepoRoot(startDir)
  const base = { toolName, toolInput, root, cwd: startDir }

  let config
  try {
    config = loadConfig(root)
  } catch (err) {
    return decide({ ...base, config: DEFAULT_CONFIG, feature: null, lockdown: `Dex could not read its config.\n\n${firstLine(err)}` })
  }
  const resolved = resolveActiveFeature(root, config)
  const worktrees = resolved.features.map((f) => f.state.worktree?.path).filter((p) => p && fs.existsSync(p))
  const withContext = { ...base, config, worktrees }
  // Hashing the working tree is the expensive part; only a publish needs it.
  const trees = isPublish(toolName, toolInput, startDir)
  const gatesFor = (f) => ({ slug: f.slug, state: f.state, gates: computeGates(root, config, f.state, { trees }) })

  if (resolved.unreadable.length) {
    return decide({
      ...withContext,
      feature: null,
      lockdown:
        `Dex could not read the state of: ${resolved.unreadable.map((u) => `${u.slug} (${u.error})`).join(', ')}.\n\n` +
        `Until that state is fixed, Dex cannot tell which gates apply.`,
    })
  }

  // A call that touches a feature's worktree is checked against that feature.
  const touched = [startDir, ...writeTargets(toolName, toolInput).map((t) => path.resolve(startDir, t))]
  const owner = featureByWorktree(resolved.features, touched)
  if (owner) return decide({ ...withContext, feature: gatesFor(owner) })

  if (resolved.brokenMarker) {
    return decide({
      ...withContext,
      feature: null,
      lockdown: `${config.stateRoot}/active names the feature "${resolved.brokenMarker}", which does not exist. Select a real feature with /dex:resume <feature>.`,
    })
  }
  return decide({
    ...withContext,
    feature: resolved.slug && resolved.state ? gatesFor(resolved) : null,
    ambiguous: resolved.ambiguous,
    candidates: resolved.candidates,
  })
}

function emitDeny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n'
  )
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  const raw = readStdin()
  let payload
  try {
    payload = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    // Unparseable hook input: allow, because refusing every tool call on a
    // malformed payload would make the repository unusable.
    process.exit(0)
  }
  try {
    const result = evaluateHookInput(payload)
    if (result.decision === DENY) emitDeny(result.reason)
    process.exit(0)
  } catch (err) {
    // The guard itself failed. Dex cannot tell which gates apply, so it refuses
    // changes and publishing, and lets reading continue.
    try {
      const result = decide({
        toolName: payload?.tool_name ?? '',
        toolInput: payload?.tool_input ?? {},
        root: payload?.cwd || process.cwd(),
        config: DEFAULT_CONFIG,
        feature: null,
        lockdown: `Dex's guard failed: ${firstLine(err)}. Diagnose with /dex:doctor.`,
      })
      if (result.decision === DENY) emitDeny(result.reason)
    } catch {
      emitDeny(`Dex's guard failed and could not evaluate this call: ${firstLine(err)}. Diagnose with /dex:doctor.`)
    }
    process.exit(0)
  }
}
