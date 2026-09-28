/**
 * dex/scripts/lib.mjs
 *
 * Shared deterministic utilities for the Dex harness.
 *
 * Design constraints:
 *  - Node >= 18, built-in modules only. No npm install, ever.
 *  - Every write to state must be atomic. A killed process must never leave
 *    half-written JSON behind.
 *  - Nothing here decides policy. Policy lives in state.mjs (gates) and
 *    guard.mjs (enforcement). This file only provides mechanism.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 1

export const PHASES = [
  'initialized',
  'questions',
  'research',
  'design',
  'structure',
  'plan',
  'worktree',
  'implement',
  'verify',
  'review',
  'pr',
  'complete',
]

/** Phases that mean "the feature is still being worked on". */
export function isActivePhase(phase) {
  return phase !== 'complete' && phase !== 'abandoned'
}

/** Ordinal position of a phase, used for "have we reached X yet" comparisons. */
export function phaseIndex(phase) {
  const i = PHASES.indexOf(phase)
  return i === -1 ? -1 : i
}

export const ARTIFACT_FILES = {
  intent: '01-intent.md',
  questions: '02-questions.md',
  research: '03-research.md',
  design: '04-design.md',
  structure: '05-structure.md',
  plan: '06-plan.md',
  implementationLog: '07-implementation-log.md',
  review: '08-review.md',
  pr: '09-pr.md',
}

export const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  strictGates: true,
  requireWorktree: true,
  requireHumanCodeApproval: true,
  requireAiReview: true,
  reviewCadence: 'final',
  maxResearchWorkers: 6,
  artifactRoot: 'docs/dex',
  stateRoot: '.dex',
}

const KNOWN_CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))
const VALID_CADENCES = new Set(['slice', 'checkpoint', 'final'])

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * An error whose message is already written for a human operator: it says what
 * went wrong AND how to recover. Callers print `.message` verbatim.
 */
export class DexError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message)
    this.name = 'DexError'
    this.exitCode = exitCode
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Turn any path into a forward-slash relative path from `root`.
 * Windows separators are normalized so guard rules can use one syntax.
 */
export function normalizeRelPath(p, root) {
  if (!p) return ''
  let s = String(p).replace(/\\/g, '/')
  let r = String(root || '').replace(/\\/g, '/')
  // Strip a Windows drive letter difference in case only matters.
  const sameDrive = (a, b) =>
    a.length > 1 && b.length > 1 && a[1] === ':' && b[1] === ':' && a[0].toLowerCase() === b[0].toLowerCase()
  if (r && sameDrive(s, r)) {
    s = s[0].toLowerCase() + s.slice(1)
    r = r[0].toLowerCase() + r.slice(1)
  }
  if (r && !r.endsWith('/')) r += '/'
  if (r && s.startsWith(r)) s = s.slice(r.length)
  // Collapse ./ and duplicate slashes but do not resolve .. (we want to see it).
  s = s.replace(/\/{2,}/g, '/').replace(/^\.\//, '')
  return s
}

/** True when `rel` is inside directory `dir` (both forward-slash relative). */
export function isUnder(rel, dir) {
  const d = dir.replace(/\/+$/, '')
  return rel === d || rel.startsWith(d + '/')
}

/**
 * Find the main checkout's root, falling back to cwd when not a repo.
 *
 * Dex state lives in the main checkout, but implementation happens in a linked
 * worktree. From inside a worktree, `--show-toplevel` names the worktree, which
 * has no `.dex/`. The common git directory is shared by every worktree, and its
 * parent is the main checkout, so that is what this returns.
 */
export function findRepoRoot(startDir = process.cwd()) {
  try {
    const run = (args) =>
      execFileSync('git', args, { cwd: startDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const top = run(['rev-parse', '--show-toplevel'])
    if (top) {
      const common = run(['rev-parse', '--path-format=absolute', '--git-common-dir'])
      // A normal checkout keeps its git directory at <root>/.git. Anything else
      // (a bare repo, a custom GIT_DIR) has no main checkout to find, so the
      // current top level is the best answer.
      if (common && path.basename(common) === '.git') return path.dirname(common)
      return top
    }
  } catch {
    // Not a git repo, or git missing. Walk up looking for .dex instead.
  }
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.dex'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(startDir)
}

export function stateRootDir(root, config) {
  return path.join(root, config.stateRoot)
}

export function featureStateDir(root, config, slug) {
  return path.join(stateRootDir(root, config), slug)
}

export function featureStatePath(root, config, slug) {
  return path.join(featureStateDir(root, config, slug), 'state.json')
}

export function featureEventsPath(root, config, slug) {
  return path.join(featureStateDir(root, config, slug), 'events.jsonl')
}

export function artifactDir(root, config, slug) {
  return path.join(root, config.artifactRoot, slug)
}

export function activeMarkerPath(root, config) {
  return path.join(stateRootDir(root, config), 'active')
}

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

/**
 * Stable kebab-case slug. Deterministic: the same description always produces
 * the same slug, so a resumed session finds the same feature.
 */
export function slugify(text, { maxWords = 6 } = {}) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const stop = new Set([
    // Only words about the act of development, never words that name the
    // capability itself: "create" and "delete" distinguish two different features.
    'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'we', 'i',
    'add', 'implement', 'ability', 'able',
  ])
  let kept = words.filter((w) => !stop.has(w))
  if (kept.length === 0) kept = words
  const slug = kept.slice(0, maxWords).join('-').replace(/^-+|-+$/g, '')
  return slug || 'feature'
}

/**
 * Clean up a slug that was supplied explicitly.
 *
 * Unlike slugify(), this keeps every word. A caller who asked for "feat-a" must
 * get "feat-a" back — dropping "a" as a stop word would silently point the
 * command at a different feature.
 */
export function sanitizeSlug(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return s
}

/** A feature name Dex accepts: lowercase letters, digits and hyphens, at most 60. */
export function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)
}

/** Names that would read as a gate in `approve <gate> <slug>`. */
export const RESERVED_SLUGS = new Set(['questions', 'design', 'structure', 'code'])

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256String(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Hash a file's contents. Returns null when the file does not exist, so
 * callers can distinguish "changed" from "never existed".
 *
 * Line endings are normalized to \n before hashing, so a checkout that
 * rewrites CRLF does not silently invalidate an approval.
 */
export function hashFile(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8')
    return sha256String(raw.replace(/\r\n/g, '\n'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// JSON IO
// ---------------------------------------------------------------------------

export function readJson(absPath, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'))
  } catch (err) {
    // Only a missing file falls back. A file that exists but does not parse is
    // an error: silently treating it as absent makes a feature disappear, and
    // the guard would then stop gating it.
    if (err && err.code === 'ENOENT' && fallback !== undefined) return fallback
    throw new DexError(
      `Dex could not read JSON at ${absPath}\n\n${err.message}\n\n` +
        `The file is present but not valid JSON. Inspect it, or delete it to start that piece of state over.`
    )
  }
}

/**
 * Atomic JSON write: serialize, validate by reparsing, write to a temp file in
 * the same directory, fsync, then rename over the target. A rename inside one
 * filesystem is atomic, so readers see either the old file or the new one.
 */
export function writeJsonAtomic(absPath, value) {
  const dir = path.dirname(absPath)
  fs.mkdirSync(dir, { recursive: true })
  const text = JSON.stringify(value, null, 2) + '\n'
  JSON.parse(text) // refuse to persist anything we cannot read back
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`)
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  fs.renameSync(tmp, absPath)
  // Best-effort directory fsync so the rename itself is durable.
  try {
    const dfd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dfd)
    } finally {
      fs.closeSync(dfd)
    }
  } catch {
    // Not supported on every platform (notably Windows). The rename still holds.
  }
  return absPath
}

export function writeFileAtomic(absPath, text) {
  const dir = path.dirname(absPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`)
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  fs.renameSync(tmp, absPath)
  return absPath
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Load .dex/config.json, merged over defaults.
 *
 * Unknown keys never change behavior; they are reported as warnings so a typo
 * like "requireHumanCodeReview" cannot silently disable a gate.
 */
/**
 * A relative path that names a real subfolder of the repository: not absolute,
 * not the repository itself, and never climbing out of it with `..`.
 */
function isContainedRelPath(p) {
  if (typeof p !== 'string' || !p.trim() || path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false
  const norm = path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '')
  return norm !== '.' && norm !== '' && norm !== '..' && !norm.startsWith('../')
}

export function loadConfig(root, { stateRoot = '.dex' } = {}) {
  const configPath = path.join(root, stateRoot, 'config.json')
  const raw = readJson(configPath, null)
  const warnings = []
  if (!raw) {
    return { ...DEFAULT_CONFIG, __warnings: warnings, __path: configPath, __exists: false }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DexError(
      `Dex config at ${configPath} must be a JSON object.\n\n` +
        `Replace it with the defaults:\n${JSON.stringify(DEFAULT_CONFIG, null, 2)}`
    )
  }
  const config = { ...DEFAULT_CONFIG }
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      warnings.push(`unknown config field "${key}" ignored (it does not change any Dex behavior)`)
      continue
    }
    config[key] = value
  }
  // Type checks. A wrong type falls back to the default and warns, rather than
  // letting "false" (a truthy string) switch off a gate.
  for (const key of ['strictGates', 'requireWorktree', 'requireHumanCodeApproval', 'requireAiReview']) {
    if (typeof config[key] !== 'boolean') {
      warnings.push(`config "${key}" must be true or false; using default ${DEFAULT_CONFIG[key]}`)
      config[key] = DEFAULT_CONFIG[key]
    }
  }
  if (!VALID_CADENCES.has(config.reviewCadence)) {
    warnings.push(
      `config "reviewCadence" must be one of slice|checkpoint|final; using default "${DEFAULT_CONFIG.reviewCadence}"`
    )
    config.reviewCadence = DEFAULT_CONFIG.reviewCadence
  }
  const workers = Number(config.maxResearchWorkers)
  if (!Number.isInteger(workers) || workers < 1 || workers > 24) {
    warnings.push(`config "maxResearchWorkers" must be an integer 1..24; using default ${DEFAULT_CONFIG.maxResearchWorkers}`)
    config.maxResearchWorkers = DEFAULT_CONFIG.maxResearchWorkers
  }
  for (const key of ['artifactRoot', 'stateRoot']) {
    if (!isContainedRelPath(config[key])) {
      warnings.push(`config "${key}" must be a folder inside the repository, such as "${DEFAULT_CONFIG[key]}"; using the default`)
      config[key] = DEFAULT_CONFIG[key]
    }
  }
  config.__warnings = warnings
  config.__path = configPath
  config.__exists = true
  return config
}

/** Write .dex/config.json only when it is absent. Never clobber operator choices. */
export function ensureConfig(root, stateRoot = '.dex') {
  const configPath = path.join(root, stateRoot, 'config.json')
  if (fs.existsSync(configPath)) return { created: false, path: configPath }
  writeJsonAtomic(configPath, DEFAULT_CONFIG)
  return { created: true, path: configPath }
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 120_000

function readLockInfo(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * How old a lock is, in milliseconds, or null when it is gone.
 *
 * A lock whose content is empty or half-written is judged by its file time, so
 * a lock being written right now is respected. A timestamp in the future means
 * a clock was wrong; such a lock is treated as stale rather than held forever.
 */
function lockAge(lockPath) {
  let stat
  try {
    stat = fs.statSync(lockPath)
  } catch {
    return null
  }
  const info = readLockInfo(lockPath)
  const stamped = info && info.acquiredAt ? Date.parse(info.acquiredAt) : NaN
  const since = Number.isFinite(stamped) ? stamped : stat.mtimeMs
  const age = Date.now() - since
  return age < -60_000 ? Infinity : Math.max(age, 0)
}

/**
 * Exclusive advisory lock for one feature's state.
 *
 * Uses O_EXCL file creation, which is atomic on every platform we care about.
 * A lock older than two minutes is treated as abandoned and reclaimed, because
 * an interrupted Claude Code session cannot clean up after itself.
 */
export function withFeatureLock(root, config, slug, fn) {
  // Checked here too: this is the first place a feature folder gets created.
  if (!isValidSlug(slug)) throw new DexError(`"${String(slug).slice(0, 80)}" is not a valid feature name.`)
  const dir = featureStateDir(root, config, slug)
  fs.mkdirSync(dir, { recursive: true })
  const lockPath = path.join(dir, '.lock')
  let fd
  let reclaimed = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const age = lockAge(lockPath)
      if (age === null) continue // it vanished between our attempt and now: try again
      if (age > LOCK_STALE_MS) {
        // Reclaim by renaming: of two processes that both see a stale lock, only
        // one rename succeeds, so only one of them goes on to take it.
        const grave = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
        try {
          fs.renameSync(lockPath, grave)
          fs.rmSync(grave, { force: true })
          reclaimed = true
        } catch {
          // Someone else reclaimed it first; the next attempt competes normally.
        }
        continue
      }
      const info = readLockInfo(lockPath)
      throw new DexError(
        `Dex feature "${slug}" is locked by another process (pid ${info?.pid ?? 'unknown'}, held ${Math.round(age / 1000)}s).\n\n` +
          `Two processes must not mutate the same feature state at once.\n\n` +
          `Wait for it to finish. If that process is gone, remove the lock:\n  rm ${lockPath}`
      )
    }
  }
  if (fd === undefined) {
    throw new DexError(`Dex could not acquire the lock at ${lockPath}. Remove it and retry.`)
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() }))
    fs.fsyncSync(fd)
  } catch {
    // A lock we cannot annotate still excludes other writers.
  }
  try {
    const result = fn({ reclaimed })
    // The feature a command just changed is the one being worked on, so the
    // guard should check that feature's gates from now on.
    if (fs.existsSync(featureStatePath(root, config, slug))) writeActiveSlug(root, config, slug)
    return result
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(lockPath)
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Keys whose values are never written to the event log. The log is a durable
 * audit trail that may be committed to the repository, so it holds decisions
 * and hashes only, never prompts, secrets, or environment contents.
 */
const REDACT_KEY = /(secret|token|password|passwd|credential|apikey|api_key|authorization|cookie|prompt|env)/i

/**
 * Secret-shaped substrings, scrubbed out of values as well as keys.
 *
 * A verification command is recorded verbatim, and a command can carry a bearer
 * token or a connection-string password. Redacting only by key name would miss
 * those, and the event log is durable and may be committed.
 */
const REDACTED = '[redacted]'
const REDACT_VALUE = [
  // Header-style credentials: keep the scheme word, drop the value.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi, `$1 ${REDACTED}`],
  [/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{12,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, REDACTED],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  [/(-{3,}BEGIN [A-Z ]*PRIVATE KEY-{3,})[\s\S]*?(-{3,}END [A-Z ]*PRIVATE KEY-{3,})/g, REDACTED],
  // NAME=value where the name says it is secret: AWS_SECRET_ACCESS_KEY=..., DB_PASSWORD=..., --password=...
  [/\b([A-Za-z_][A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${REDACTED}`],
  [/(^|[\s"'])((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1$2${REDACTED}`],
  // curl -u user:pass, --user user:pass
  [/((?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)[^\s"']+/g, `$1${REDACTED}`],
  // mysql -pSECRET (the password is glued to -p)
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n;|&]*?\s-p)(?=\S)(?!\s)\S+/g, `$1${REDACTED}`],
]

/**
 * Replace anything that looks like a credential with a marker. Callers scrub
 * before they shorten text, so a cut can never leave half a secret behind.
 */
export function scrubSecrets(text) {
  let out = String(text)
  for (const [re, replacement] of REDACT_VALUE) out = out.replace(re, replacement)
  return out
}

/** Scrub, then cut to `max` characters. */
export function scrubAndClip(text, max) {
  const s = scrubSecrets(text)
  return s.length > max ? s.slice(0, max) : s
}

export function sanitizeDetails(details) {
  if (details === null || details === undefined) return {}
  if (typeof details !== 'object' || Array.isArray(details)) return { value: scrubSecrets(String(details)).slice(0, 500) }
  const out = {}
  for (const [key, value] of Object.entries(details)) {
    if (REDACT_KEY.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'string') {
      const scrubbed = scrubSecrets(value)
      out[key] = scrubbed.length > 500 ? scrubbed.slice(0, 500) + '…' : scrubbed
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 40).map((v) => {
        if (v && typeof v === 'object') return sanitizeDetails(v)
        return typeof v === 'string' ? scrubSecrets(v) : v
      })
    } else if (typeof value === 'object') {
      out[key] = sanitizeDetails(value)
    }
  }
  return out
}

export function appendEvent(root, config, slug, event, details = {}) {
  const line =
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      feature: slug,
      details: sanitizeDetails(details),
    }) + '\n'
  const p = featureEventsPath(root, config, slug)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.appendFileSync(p, line, 'utf8')
  return p
}

export function readEvents(root, config, slug) {
  const p = featureEventsPath(root, config, slug)
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { event: 'unparseable_event_line', raw: l.slice(0, 200) }
      }
    })
}

// ---------------------------------------------------------------------------
// Feature state
// ---------------------------------------------------------------------------

export function newFeatureState(slug, title, config) {
  const artifacts = {}
  for (const [key, file] of Object.entries(ARTIFACT_FILES)) {
    artifacts[key] = `${config.artifactRoot}/${slug}/${file}`
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    feature: {
      slug,
      title,
      createdAt: new Date().toISOString(),
    },
    phase: 'initialized',
    artifacts,
    approvals: {
      questions: null,
      design: null,
      structure: null,
      humanCodeReview: null,
    },
    slices: [],
    verification: {
      status: 'not-run',
      commands: [],
      lastResult: null,
      ranAt: null,
    },
    aiReview: {
      status: 'not-run',
      conclusion: null,
      blockers: 0,
      completedAt: null,
    },
    worktree: {
      ready: false,
      branch: null,
      path: null,
      base: null,
    },
    blocked: null,
    pr: {
      created: false,
      url: null,
      createdAt: null,
    },
  }
}

export function loadFeatureState(root, config, slug) {
  const p = featureStatePath(root, config, slug)
  const state = readJson(p, null)
  if (!state) {
    throw new DexError(
      `Dex has no feature named "${slug}".\n\n` +
        `Expected state at: ${normalizeRelPath(p, root)}\n\n` +
        `Existing features: ${listFeatures(root, config).map((f) => f.slug).join(', ') || '(none)'}\n\n` +
        `Start one with:\n  /dex:start <feature description>`
    )
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new DexError(
      `Feature "${slug}" was written by a different Dex schema (found ${state.schemaVersion}, this build expects ${SCHEMA_VERSION}).\n\n` +
        `Dex will not guess how to migrate engineering approvals. Finish the feature with the matching Dex version, or archive it and start again.`
    )
  }
  return state
}

export function saveFeatureState(root, config, slug, state) {
  return writeJsonAtomic(featureStatePath(root, config, slug), state)
}

export function listFeatures(root, config) {
  return scanFeatures(root, config).features
}

/**
 * Every feature folder under the state root, split into the ones Dex can read
 * and the ones it cannot (state.json present but unparseable or malformed).
 * Unreadable features must not be skipped silently by anything that gates.
 */
export function scanFeatures(root, config) {
  const dir = stateRootDir(root, config)
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { features: [], unreadable: [] }
  }
  const features = []
  const unreadable = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const statePath = path.join(dir, e.name, 'state.json')
    if (!fs.existsSync(statePath)) continue
    let state
    try {
      state = readJson(statePath)
    } catch (err) {
      unreadable.push({ slug: e.name, error: err.message.split('\n')[0] })
      continue
    }
    if (!state || typeof state !== 'object' || !state.feature || !state.approvals) {
      unreadable.push({ slug: e.name, error: 'state.json is missing required fields' })
      continue
    }
    features.push({ slug: state.feature.slug || e.name, title: state.feature.title, phase: state.phase, state })
  }
  features.sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
  return { features, unreadable }
}

export function readActiveSlug(root, config) {
  try {
    const s = fs.readFileSync(activeMarkerPath(root, config), 'utf8').trim()
    return s || null
  } catch {
    return null
  }
}

export function writeActiveSlug(root, config, slug) {
  return writeFileAtomic(activeMarkerPath(root, config), slug + '\n')
}

/**
 * Resolve which feature a non-interactive caller (a hook) should gate against.
 *
 * Returns { slug, state, ambiguous, candidates }. When several features are
 * active and no marker names one, `ambiguous` is true and `slug` is null:
 * callers must not guess.
 */
export function resolveActiveFeature(root, config) {
  const marked = readActiveSlug(root, config)
  const { features, unreadable } = scanFeatures(root, config)
  const active = features.filter((f) => isActivePhase(f.phase))
  const base = { unreadable, brokenMarker: null, features }
  if (marked) {
    const hit = features.find((f) => f.slug === marked)
    if (hit) return { ...base, slug: hit.slug, state: hit.state, ambiguous: false, candidates: active.map((f) => f.slug) }
    // A marker naming a feature that does not exist, while features do exist,
    // means Dex cannot tell which gates apply. Callers must not guess.
    if (features.length || unreadable.length) base.brokenMarker = marked
  }
  if (base.brokenMarker) return { ...base, slug: null, state: null, ambiguous: false, candidates: active.map((f) => f.slug) }
  if (active.length === 1) {
    return { ...base, slug: active[0].slug, state: active[0].state, ambiguous: false, candidates: [active[0].slug] }
  }
  if (active.length === 0) {
    return { ...base, slug: null, state: null, ambiguous: false, candidates: [] }
  }
  return { ...base, slug: null, state: null, ambiguous: true, candidates: active.map((f) => f.slug) }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export function git(args, { cwd = process.cwd(), allowFail = false, maxBuffer = 64 * 1024 * 1024, env = undefined } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    if (allowFail) return null
    throw new DexError(`git ${args.join(' ')} failed:\n${err.stderr || err.message}`)
  }
}

/**
 * Keep Dex's state folder out of `git status` by listing it in the repository's
 * local ignore file (`info/exclude`). That file is never committed, so the
 * user's .gitignore stays untouched. Adds the line once; does nothing outside git.
 */
export function ignoreStateRoot(root, config) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, allowFail: true })?.trim()
  if (!common) return false
  const excludePath = path.join(common, 'info', 'exclude')
  const line = `/${config.stateRoot.replace(/^\/+|\/+$/g, '')}/`
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
  if (current.split('\n').some((l) => l.trim() === line)) return false
  fs.mkdirSync(path.dirname(excludePath), { recursive: true })
  fs.writeFileSync(excludePath, current + (current && !current.endsWith('\n') ? '\n' : '') + line + '\n')
  return true
}

export function isGitRepo(cwd) {
  return git(['rev-parse', '--is-inside-work-tree'], { cwd, allowFail: true })?.trim() === 'true'
}

export function currentBranch(cwd) {
  const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, allowFail: true })
  return b ? b.trim() : null
}

/** Pick a sensible integration branch to diff against. */
export function detectBaseBranch(cwd) {
  const originHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd, allowFail: true })
  if (originHead) return originHead.trim()
  for (const cand of ['main', 'master', 'develop', 'trunk']) {
    if (git(['rev-parse', '--verify', '--quiet', cand], { cwd, allowFail: true })) return cand
  }
  return null
}

/**
 * The feature's own Dex documents, as a git pathspec. These are the only files
 * left out of the code approval: they are written after approval (the
 * implementation log, the review, the PR description) and are copied into the
 * PR by /dex:pr. Anything else under the artifact root is ordinary code.
 */
export function artifactPathspec(config, slug) {
  return `:(glob)${config.artifactRoot}/${slug}/0[1-9]-*.md`
}

function trace(what, dir) {
  if (process.env.DEX_TRACE) process.stderr.write(`dex trace: ${what} ${dir}\n`)
}

/**
 * Build a tree in a throwaway index so the real index is never touched.
 * `fill` puts the right content into the index; the feature's own documents are
 * then removed and the tree is written. Returns the tree SHA, or null.
 */
function treeFromIndex(dir, config, slug, fill) {
  const indexPath = path.join(os.tmpdir(), `dex-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  const env = { ...process.env, GIT_INDEX_FILE: indexPath }
  try {
    fill(env)
    git(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', artifactPathspec(config, slug)], { cwd: dir, env })
    return git(['write-tree'], { cwd: dir, env }).trim() || null
  } finally {
    try {
      fs.rmSync(indexPath, { force: true })
    } catch {
      /* best effort */
    }
  }
}

/**
 * The tree the code approval covers: everything in the checkout at `dir` that
 * git would commit with `git add -A` (tracked files, plus untracked files that
 * are not ignored), minus the feature's own documents.
 *
 * Staging and committing do not change it. Any edit, new file, deletion or
 * rename does. Returns null outside a git repository.
 */
export function workTree(dir, config, slug) {
  if (!isGitRepo(dir)) return null
  trace('workTree', dir)
  return treeFromIndex(dir, config, slug, (env) => {
    // Start from a copy of the real index so git can reuse its file stat cache.
    const realIndex = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: dir, allowFail: true })?.trim()
    if (realIndex && fs.existsSync(realIndex)) fs.copyFileSync(realIndex, env.GIT_INDEX_FILE)
    else git(['read-tree', 'HEAD'], { cwd: dir, env, allowFail: true })
    git(['add', '-A', '--', '.'], { cwd: dir, env })
  })
}

/** The tree of a commit (HEAD by default), minus the feature's own documents: what a push would publish. */
export function headTree(dir, config, slug, rev = 'HEAD') {
  if (!isGitRepo(dir)) return null
  trace('headTree', dir)
  return treeFromIndex(dir, config, slug, (env) => git(['read-tree', rev], { cwd: dir, env }))
}

// ---------------------------------------------------------------------------
// The git pre-push hook
// ---------------------------------------------------------------------------

const PRE_PUSH_MARKER = '# dex pre-push hook'
export const PRE_PUSH_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pre-push.mjs')

/** The line to add to an existing pre-push hook so it runs Dex's check too. */
export function prePushLine() {
  return `node "${PRE_PUSH_SCRIPT}" "$@" || exit 1`
}

/**
 * Whether Dex's pre-push hook is installed in the repository at `root`.
 * Returns { installed, file, reason }.
 */
export function prePushStatus(root) {
  if (!isGitRepo(root)) return { installed: false, file: null, reason: 'not a git repository' }
  const custom = git(['config', '--get', 'core.hooksPath'], { cwd: root, allowFail: true })?.trim()
  const dir = git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd: root, allowFail: true })?.trim()
  const file = dir ? path.join(dir, 'pre-push') : null
  if (file && fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(PRE_PUSH_MARKER)) {
    return { installed: true, file, reason: null }
  }
  if (custom) return { installed: false, file, reason: `core.hooksPath is set to ${custom}`, custom }
  if (file && fs.existsSync(file)) return { installed: false, file, reason: 'another pre-push hook is already there', foreign: true }
  return { installed: false, file, reason: 'no pre-push hook' }
}

/**
 * Install the hook. It gates pushes of dex/* branches and passes every other
 * push through. Never overwrites a hook Dex did not write, and never installs
 * into a custom hooks path: it throws with the one line to add instead.
 */
export function installPrePushHook(root) {
  const status = prePushStatus(root)
  if (status.installed) {
    writePrePushHook(status.file)
    return status
  }
  if (!status.file || status.reason === 'not a git repository') throw new DexError('Dex can only install its pre-push hook in a git repository.')
  const addLine =
    `Add this line to that hook, near the top and before anything that reads standard input:\n\n  ${prePushLine()}`
  if (status.custom) {
    throw new DexError(`Dex will not install its pre-push hook: core.hooksPath is set to ${status.custom}, so hooks are managed elsewhere.\n\n${addLine}`)
  }
  if (status.foreign) {
    throw new DexError(`Dex will not overwrite the existing pre-push hook at ${status.file}.\n\n${addLine}`)
  }
  writePrePushHook(status.file)
  return { installed: true, file: status.file, reason: null }
}

function writePrePushHook(file) {
  const script = PRE_PUSH_SCRIPT.replace(/"/g, '\\"')
  const body = [
    '#!/bin/sh',
    `${PRE_PUSH_MARKER}: checks Dex's gates before a dex/* branch is pushed.`,
    '# Installed by: node <dex>/scripts/state.mjs install-hook',
    `script="${script}"`,
    'if [ -f "$script" ]; then',
    '  exec node "$script" "$@"',
    'fi',
    '# The Dex plugin moved or was removed: refuse dex/* pushes, let everything else through.',
    'while read -r local_ref local_sha remote_ref remote_sha; do',
    '  case "$remote_ref" in',
    '    refs/heads/dex/*)',
    '      echo "Dex: cannot check this dex/* push because $script is missing. Reinstall the hook with: node <dex>/scripts/state.mjs install-hook" >&2',
    '      exit 1 ;;',
    '  esac',
    'done',
    'exit 0',
    '',
  ].join('\n')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

/** The tree of a commit, or null. */
export function commitTree(dir, rev) {
  return git(['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { cwd: dir, allowFail: true })?.trim() || null
}

/** The commit where the feature branched from `baseRef`, or null. */
export function mergeBase(dir, baseRef) {
  if (!baseRef) return null
  return git(['merge-base', baseRef, 'HEAD'], { cwd: dir, allowFail: true })?.trim() || null
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function pad(s, width) {
  const str = String(s ?? '')
  return str.length >= width ? str : str + ' '.repeat(width - str.length)
}

export function nowIso() {
  return new Date().toISOString()
}
