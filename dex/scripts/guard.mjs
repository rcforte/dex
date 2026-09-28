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
 * It does two things and nothing else:
 *   1. Refuses production-code modification before the implementation gates pass.
 *   2. Refuses push / pull-request operations before human code approval is current.
 *
 * Deliberate design choices:
 *   - No active Dex feature means no gating at all. Dex must not hijack every
 *     coding task in the repository.
 *   - Shell inspection is conservative pattern matching, not a shell parser.
 *     A missed mutation is acceptable; blocking `git status` is not.
 *   - An internal error allows ordinary work but still refuses publish
 *     operations, so a crashed guard can never open the PR gate.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  findRepoRoot,
  isUnder,
  loadConfig,
  normalizeRelPath,
  resolveActiveFeature,
} from './lib.mjs'
import { computeGates, derivePhase, nextAction } from './state.mjs'

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch'])
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'PowerShell', 'Shell'])

// ---------------------------------------------------------------------------
// Shell pattern tables
// ---------------------------------------------------------------------------

/**
 * Operations that publish work outward. Gated by human code approval in every
 * phase, because these are the irreversible, outward-facing steps.
 */
const PUBLISH_PATTERNS = [
  { re: /^git\b(?:\s+-[cC]\s+\S+)*\s+push\b/, what: 'git push' },
  { re: /^git\b.*\s+send-email\b/, what: 'git send-email' },
  { re: /^git\s+request-pull\b/, what: 'git request-pull' },
  { re: /^gh\s+pr\s+(?:create|merge|ready)\b/, what: 'gh pr create/merge' },
  { re: /^gh\s+release\s+create\b/, what: 'gh release create' },
  { re: /^glab\s+mr\s+create\b/, what: 'glab mr create' },
  { re: /^hub\s+pull-request\b/, what: 'hub pull-request' },
]

/**
 * Repository mutations refused before the implementation gates pass.
 * Ordered roughly by how often each appears in real sessions.
 */
const MUTATION_PATTERNS = [
  // --- git history and working tree ---
  { re: /^git\b(?:\s+-[cC]\s+\S+)*\s+commit\b/, what: 'git commit' },
  { re: /^git\s+(?:merge|rebase|cherry-pick|revert|am|apply|filter-branch)(?=\s|$)/, what: 'a git history operation' },
  { re: /^git\s+reset(?=\s|$)/, what: 'git reset' },
  { re: /^git\s+restore(?=\s|$)/, what: 'git restore' },
  { re: /^git\s+checkout\s+(?:--|\.)/, what: 'git checkout -- (discards changes)' },
  { re: /^git\s+clean(?=\s|$)/, what: 'git clean' },
  { re: /^git\s+stash\s+(?:push|save|pop|apply|drop|clear)\b/, what: 'git stash mutation' },
  { re: /^git\s+stash\s*$/, what: 'git stash' },
  { re: /^git\s+(?:rm|mv)(?=\s|$)/, what: 'git rm/mv' },
  { re: /^git\s+branch\s+.*(?:-(?:d|D|m|M)(?=\s|$)|--(?:delete|move))/, what: 'git branch delete/rename' },
  { re: /^git\s+tag\s+.*(?:-d(?=\s|$)|--delete)/, what: 'git tag -d' },
  { re: /^git\s+worktree\s+(?:remove|prune)\b/, what: 'git worktree remove/prune' },
  { re: /^git\s+update-ref(?=\s|$)/, what: 'git update-ref' },

  // --- destructive file operations ---
  { re: /^rm(?=\s|$)/, what: 'rm' },
  { re: /^rmdir(?=\s|$)/, what: 'rmdir' },
  { re: /^mv(?=\s|$)/, what: 'mv' },
  { re: /^cp(?=\s|$)/, what: 'cp' },
  { re: /^(?:dd|shred|truncate)(?=\s|$)/, what: 'a destructive file command' },
  { re: /^ln(?=\s|$)/, what: 'ln' },
  { re: /\bfind\b.*\s-delete\b/, what: 'find -delete' },
  { re: /\bfind\b.*\s-exec\s+(?:rm|mv|sed|truncate)\b/, what: 'find -exec with a mutating command' },

  // --- in-place editors ---
  { re: /^sed\b[^|]*\s-[a-zA-Z]*i\b/, what: 'sed -i (in-place edit)' },
  { re: /^(?:perl|ruby)\b[^|]*\s-[a-zA-Z]*i\b/, what: 'an in-place interpreter edit' },
  { re: /^g?awk\b[^|]*-i\s+inplace\b/, what: 'awk -i inplace' },
  { re: /^patch(?=\s|$)/, what: 'patch' },
  { re: /^(?:ed|ex)\s/, what: 'ed/ex' },

  // --- dependency installation ---
  { re: /^(?:npm|pnpm)\s+(?:install|i|ci|add|update|uninstall|remove|rm)\b/, what: 'an npm/pnpm dependency change' },
  { re: /^(?:yarn|bun)\s+(?:add|install|remove|up|upgrade)\b/, what: 'a yarn/bun dependency change' },
  { re: /^(?:pip|pip3)\s+(?:install|uninstall)\b/, what: 'a pip dependency change' },
  { re: /^(?:poetry|uv)\s+(?:add|remove|install|sync)\b/, what: 'a Python dependency change' },
  { re: /^cargo\s+(?:add|remove|install|update)\b/, what: 'a cargo dependency change' },
  { re: /^go\s+(?:get|install)\b/, what: 'a go dependency change' },
  { re: /^go\s+mod\s+(?:tidy|edit|vendor)\b/, what: 'a go module change' },
  { re: /^(?:gem|bundle)\s+(?:install|add|update)\b/, what: 'a Ruby dependency change' },
  { re: /^composer\s+(?:require|install|update|remove)\b/, what: 'a composer dependency change' },
  { re: /^(?:apt|apt-get|yum|dnf|apk|brew|choco|winget|pacman)\s+(?:install|add|remove|upgrade|-S)\b/, what: 'a system package installation' },

  // --- database migrations ---
  { re: /^flyway\s+(?:migrate|clean|undo|repair)\b/, what: 'a Flyway migration' },
  { re: /^liquibase\s+(?:update|rollback|dropAll)\b/, what: 'a Liquibase migration' },
  { re: /^alembic\s+(?:upgrade|downgrade|stamp)\b/, what: 'an Alembic migration' },
  { re: /^(?:npx\s+)?prisma\s+(?:migrate|db\s+push)\b/, what: 'a Prisma migration' },
  { re: /^(?:npx\s+)?(?:knex|sequelize|sequelize-cli|dbmate|goose|atlas|sqlx)\b.*\b(?:migrate|db:migrate|up|apply|run)\b/, what: 'a database migration' },
  { re: /\bmanage\.py\s+migrate\b/, what: 'a Django migration' },
  { re: /^(?:bin\/)?rails\s+db:(?:migrate|rollback|drop|reset)\b/, what: 'a Rails migration' },
  { re: /^(?:mysql|psql|sqlite3|mongosh)\b.*\b(?:DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i, what: 'a destructive database statement' },
]

/** Redirect targets that are never repository source. */
const SAFE_REDIRECT = [
  /^\/dev\/(?:null|stdout|stderr|fd\/\d+)$/,
  /^&\d+$/,
  /^\/tmp\//,
  /^\/var\/tmp\//,
  /^\$(?:TMPDIR|TEMP|TMP)\b/,
  /^[A-Za-z]:[\\/](?:Temp|Windows[\\/]Temp)/i,
]

/**
 * Split a command line into rough segments so patterns can be anchored at the
 * start of each one. This is intentionally simple: `grep "rm -rf" file` must
 * not look like an `rm`.
 */
export function splitSegments(command) {
  const parts = String(command || '')
    .split(/\n|&&|\|\||[;|]|(?<!\d)>\(|\$\(|`/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.map(stripPrefixes).filter(Boolean)
}

/** Remove leading env assignments and transparent wrappers. */
function stripPrefixes(segment) {
  let s = segment.replace(/^[({\s]+/, '').replace(/[)\s]+$/, '')
  for (;;) {
    const before = s
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '')
    s = s.replace(/^(?:sudo|doas|command|exec|nohup|time|env|nice|ionice|xargs|then|else|do|fi|done)\s+/, '')
    if (s === before) break
  }
  return s.trim()
}

/**
 * Find redirects that write somewhere other than a scratch location.
 * Returns the offending targets.
 */
export function unsafeRedirectTargets(command, { artifactRoot, stateRoot, root }) {
  const targets = []
  const re = /(?:^|\s)\d?>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g
  let m
  while ((m = re.exec(String(command || '')))) {
    const raw = m[1].replace(/^["']|["']$/g, '')
    if (SAFE_REDIRECT.some((r) => r.test(raw))) continue
    const rel = normalizeRelPath(raw, root)
    if (isUnder(rel, artifactRoot) || isUnder(rel, stateRoot)) continue
    targets.push(raw)
  }
  return targets
}

/** `tee` also writes files, and it is easy to miss in a pipeline. */
function unsafeTeeTargets(segments, ctx) {
  const out = []
  for (const seg of segments) {
    if (!/^tee\b/.test(seg)) continue
    const args = seg.split(/\s+/).slice(1).filter((a) => !a.startsWith('-'))
    for (const a of args) {
      const rel = normalizeRelPath(a.replace(/^["']|["']$/g, ''), ctx.root)
      if (isUnder(rel, ctx.artifactRoot) || isUnder(rel, ctx.stateRoot)) continue
      if (SAFE_REDIRECT.some((r) => r.test(a))) continue
      out.push(a)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

/** Every filesystem path a given tool call would write to. */
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
  if (Array.isArray(input.edits)) for (const e of input.edits) push(e?.file_path ?? e?.filePath)
  if (Array.isArray(input.files)) for (const f of input.files) push(typeof f === 'string' ? f : f?.file_path)
  return out
}

/**
 * Relativize a path for gate checks. Paths inside the feature's worktree are
 * relativized against the worktree, so `docs/dex/**` is recognized there too.
 */
function relativizeForGates(target, root, worktreePath) {
  if (worktreePath) {
    const relToWt = normalizeRelPath(target, worktreePath)
    const abs = String(target).replace(/\\/g, '/')
    const wt = String(worktreePath).replace(/\\/g, '/')
    if (abs.startsWith(wt.endsWith('/') ? wt : wt + '/')) return relToWt
  }
  return normalizeRelPath(target, root)
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
 * @param {string} args.root          repository root
 * @param {object} args.config        loaded Dex config
 * @param {object|null} args.feature  { slug, state, gates } or null
 * @param {boolean} args.ambiguous    several active features, none marked
 * @param {string[]} args.candidates
 */
export function decide({ toolName, toolInput, root, config, feature, ambiguous = false, candidates = [] }) {
  const isEdit = EDIT_TOOLS.has(toolName)
  const isShell = SHELL_TOOLS.has(toolName)
  if (!isEdit && !isShell) return allow('tool is not gated by Dex')

  const command = isShell ? String(toolInput?.command ?? toolInput?.script ?? '') : ''
  const segments = isShell ? splitSegments(command) : []
  const publishHit = segments.map((s) => PUBLISH_PATTERNS.find((p) => p.re.test(s))).find(Boolean)

  // Several active features and none marked current: do not guess which gates
  // apply. Ordinary work proceeds; the irreversible step does not.
  if (ambiguous) {
    if (publishHit) {
      return denial(
        `Dex blocked ${publishHit.what} because several features are active and none is marked current:\n` +
          candidates.map((c) => `  - ${c}`).join('\n') +
          `\n\nDex will not guess which feature's code approval applies to this push.\n\n` +
          `Select one:\n  /dex:resume <feature>`
      )
    }
    return allow('several active features; only publish operations are gated')
  }

  if (!feature) return allow('no active Dex feature; Dex does not gate ordinary work')

  const { slug, state, gates } = feature
  // Derive the phase rather than trusting state.phase: the stored value is a
  // cached label that lags whenever an artifact is written without a CLI call.
  const phase = derivePhase(gates, state)
  const worktreePath = state.worktree?.path && fs.existsSync(state.worktree.path) ? state.worktree.path : null
  const ctx = { root, artifactRoot: config.artifactRoot, stateRoot: config.stateRoot }

  // --- Publish gate: applies in every phase ------------------------------
  if (publishHit) {
    if (gates.canPr.allowed) return allow('all pull-request gates satisfied')
    return denial(
      `Dex blocked ${publishHit.what} for feature "${slug}".\n\n` +
        `Unsatisfied requirements:\n` +
        gates.canPr.blockers.map((b) => `  - ${b}`).join('\n') +
        `\n\n` +
        (gates.humanCodeReview.approved
          ? ''
          : `A human has to read the production diff. AI review and passing tests do not substitute for that.\n\n` +
            `  git -C ${worktreePath ?? root} diff --stat ${state.worktree?.base ?? ''}\n` +
            `  git -C ${worktreePath ?? root} diff ${state.worktree?.base ?? ''}\n\n` +
            `Then:\n  /dex:approve code ${slug}\n\n`) +
        `Full state:\n  /dex:status ${slug}`
    )
  }

  // --- Everything below is only gated before implementation starts --------
  if (gates.canImplement.allowed) {
    return allow('implementation gates satisfied')
  }

  const blockerList = gates.canImplement.blockers.map((b) => `  - ${b}`).join('\n')
  let nextCmd = null
  try {
    nextCmd = nextAction(root, config, state, gates).command
  } catch {
    // A malformed state must still produce a refusal, just a less specific one.
    nextCmd = null
  }

  if (isEdit) {
    const targets = writeTargets(toolName, toolInput)
    if (!targets.length) return allow('no file target to evaluate')
    const offending = targets.filter((t) => {
      const rel = relativizeForGates(t, root, worktreePath)
      return !isUnder(rel, config.artifactRoot) && !isUnder(rel, config.stateRoot)
    })
    if (!offending.length) return allow('writing Dex artifacts or state')
    return denial(
      `Dex blocked production code modification (${toolName}) for feature "${slug}".\n\n` +
        `Current phase: ${phase}\n` +
        `Blocked file(s):\n` +
        offending.map((t) => `  - ${relativizeForGates(t, root, worktreePath)}`).join('\n') +
        `\n\nRequired before implementation:\n${blockerList}\n\n` +
        `Writes to ${config.artifactRoot}/** and ${config.stateRoot}/** are allowed right now.\n\n` +
        `Next:\n  ${nextCmd ?? `/dex:status ${slug}`}`
    )
  }

  // --- Shell mutations before implementation ------------------------------
  for (const seg of segments) {
    const hit = MUTATION_PATTERNS.find((p) => p.re.test(seg))
    if (!hit) continue
    return denial(
      `Dex blocked ${hit.what} for feature "${slug}" because implementation has not been unlocked.\n\n` +
        `Command segment:\n  ${seg.slice(0, 200)}\n\n` +
        `Current phase: ${phase}\n` +
        `Required before implementation:\n${blockerList}\n\n` +
        `Read-only inspection (git status, git diff, git log, tests, builds) is allowed.\n\n` +
        `Next:\n  ${nextCmd ?? `/dex:status ${slug}`}`
    )
  }

  const redirects = unsafeRedirectTargets(command, ctx)
  const tees = unsafeTeeTargets(segments, ctx)
  const writes = [...redirects, ...tees]
  if (writes.length) {
    return denial(
      `Dex blocked a shell redirect that writes outside the Dex artifact directories for feature "${slug}".\n\n` +
        `Target(s):\n` +
        writes.map((t) => `  - ${t}`).join('\n') +
        `\n\nCurrent phase: ${phase}\n` +
        `Required before implementation:\n${blockerList}\n\n` +
        `Redirects to /dev/null, /tmp, ${config.artifactRoot}/** and ${config.stateRoot}/** are allowed.\n\n` +
        `Next:\n  ${nextCmd ?? `/dex:status ${slug}`}`
    )
  }

  return allow('no repository mutation detected')
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

/** Build the decision inputs from a raw PreToolUse payload. */
export function evaluateHookInput(payload, { cwd = process.cwd() } = {}) {
  const toolName = payload?.tool_name ?? payload?.toolName ?? ''
  const toolInput = payload?.tool_input ?? payload?.toolInput ?? {}
  const startDir = payload?.cwd || cwd
  const root = findRepoRoot(startDir)
  const config = loadConfig(root)
  const resolved = resolveActiveFeature(root, config)
  let feature = null
  if (resolved.slug && resolved.state) {
    feature = { slug: resolved.slug, state: resolved.state, gates: computeGates(root, config, resolved.state) }
  }
  return decide({
    toolName,
    toolInput,
    root,
    config,
    feature,
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

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
if (isMain) {
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
    // The guard itself failed. Ordinary work continues, but the irreversible
    // step is still refused, so a crash can never open the PR gate.
    const toolName = payload?.tool_name ?? ''
    const command = String(payload?.tool_input?.command ?? '')
    const publishing = splitSegments(command).some((s) => PUBLISH_PATTERNS.some((p) => p.re.test(s)))
    if (publishing) {
      emitDeny(
        `Dex could not evaluate its gates, so it refused a publish operation rather than risk pushing unreviewed code.\n\n` +
          `Error: ${err.message}\n\n` +
          `Diagnose with:\n  /dex:doctor`
      )
      process.exit(0)
    }
    process.stderr.write(`dex guard: ${err.message} (allowing ${toolName || 'tool call'})\n`)
    process.exit(0)
  }
}
