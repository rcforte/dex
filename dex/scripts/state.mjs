#!/usr/bin/env node
/**
 * dex/scripts/state.mjs
 *
 * The Dex state machine and its command-line interface.
 *
 * This file owns every gate decision. Skills call it; they do not reimplement
 * it in prose. If a rule can be checked here, it is checked here, because a
 * model can forget an instruction and a program cannot.
 *
 * Usage:
 *   node state.mjs init <slug> <title>
 *   node state.mjs status <slug>
 *   node state.mjs check <slug>                  (JSON gate report)
 *   node state.mjs next <slug>
 *   node state.mjs approve <questions|design|structure|code> <slug>
 *   node state.mjs transition <slug> <event>
 *   node state.mjs set-slices <slug> <S1:name> [S2:name ...]
 *   node state.mjs start-slice <slug> <id>
 *   node state.mjs finish-slice <slug> <id> [--note "..."]
 *   node state.mjs block-slice <slug> <id> --reason "..."
 *   node state.mjs verification <slug> <pass|fail> [--command "..." --exit N ...]
 *   node state.mjs record-review <slug> <pass|remediation-required> [--blockers N]
 *   node state.mjs record-worktree <slug> <branch> <path> [--base <ref>]
 *   node state.mjs record-pr <slug> [--url <url>]
 *   node state.mjs drift <slug> --reason "..." [--slice S2]
 *   node state.mjs unblock <slug>
 *   node state.mjs active [<slug>]
 *   node state.mjs list
 *   node state.mjs config
 *   node state.mjs diff-hash [<slug>]      print the tree the code approval would cover
 *   node state.mjs stage-workflow <research|review>   copy a workflow into the project so the Workflow tool can load it
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  ARTIFACT_FILES,
  DexError,
  PHASES,
  appendEvent,
  artifactDir,
  currentBranch,
  detectBaseBranch,
  commitTree,
  headTree,
  mergeBase,
  workTree,
  ensureConfig,
  featureStateDir,
  findRepoRoot,
  hashFile,
  git,
  ignoreStateRoot,
  installPrePushHook,
  stageWorkflow,
  isGitRepo,
  listFeatures,
  loadConfig,
  loadFeatureState,
  newFeatureState,
  normalizeRelPath,
  nowIso,
  pad,
  phaseIndex,
  readActiveSlug,
  readEvents,
  resolveActiveFeature,
  isValidSlug,
  RESERVED_SLUGS,
  sanitizeSlug,
  scrubAndClip,
  saveFeatureState,
  withFeatureLock,
  writeActiveSlug,
} from './lib.mjs'

// ---------------------------------------------------------------------------
// Gate computation — the single source of truth
// ---------------------------------------------------------------------------

/** Status vocabulary used across status/next/guard so output stays predictable. */
export const GATE = {
  MISSING: 'MISSING',
  PENDING: 'PENDING',
  DRAFT: 'DRAFT',
  COMPLETE: 'COMPLETE',
  APPROVED: 'APPROVED',
  STALE: 'STALE',
  NOT_RUN: 'NOT-RUN',
  PASS: 'PASS',
  FAIL: 'FAIL',
  READY: 'READY',
  NOT_READY: 'NOT-READY',
  NOT_REQUIRED: 'NOT-REQUIRED',
  REQUIRED: 'REQUIRED',
  BLOCKED: 'BLOCKED',
  IN_PROGRESS: 'IN-PROGRESS',
  CREATED: 'CREATED',
  REMEDIATION: 'REMEDIATION-REQUIRED',
}

function artifactAbs(root, state, key) {
  return path.join(root, state.artifacts[key])
}

function artifactExists(root, state, key) {
  const p = artifactAbs(root, state, key)
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

/**
 * Evaluate one artifact-bound approval.
 *
 * An approval is a claim about a specific artifact's bytes. If the bytes moved,
 * the claim is void: we report STALE rather than quietly honoring it.
 */
function approvalStatus(root, state, gateKey, artifactKey) {
  const approval = state.approvals[gateKey]
  const exists = artifactExists(root, state, artifactKey)
  if (!exists) {
    if (approval?.approved) {
      return { status: GATE.STALE, stale: true, approved: false, reason: `${state.artifacts[artifactKey]} was emptied or deleted after it was approved` }
    }
    return { status: GATE.MISSING, stale: false, approved: false, reason: 'artifact does not exist' }
  }
  if (!approval || !approval.approved) {
    return { status: GATE.DRAFT, stale: false, approved: false, reason: 'awaiting human approval' }
  }
  const current = hashFile(artifactAbs(root, state, artifactKey))
  if (current !== approval.artifactHash) {
    return {
      status: GATE.STALE,
      stale: true,
      approved: false,
      approvedHash: approval.artifactHash,
      currentHash: current,
      reason: `${artifactKey} changed after approval`,
    }
  }
  // One level of dependency: the design rests on the approved questions, the
  // structure on the approved design. Re-approving the earlier document with
  // new content makes this approval stale.
  const up = approval.upstream
  if (up && typeof up.hash === 'string' && state.approvals[up.gate]?.artifactHash !== up.hash) {
    return {
      status: GATE.STALE,
      stale: true,
      approved: false,
      reason: `${UPSTREAM_CHANGED[up.gate]} re-approved with new content after the ${gateKey} was approved; re-read the ${gateKey} and approve it again`,
    }
  }
  return { status: GATE.APPROVED, stale: false, approved: true, approvedAt: approval.approvedAt, artifactHash: current }
}

/** What each artifact approval rests on. */
const UPSTREAM = { design: 'questions', structure: 'design' }
const UPSTREAM_CHANGED = { questions: 'the questions were', design: 'the design was' }

/** The checkout the feature's code lives in: its worktree, or the main checkout. */
export function featureDir(root, state) {
  return state.worktree?.path && fs.existsSync(state.worktree.path) ? state.worktree.path : root
}

/**
 * Evaluate the human code approval. It binds to the git tree of the feature's
 * checkout (see workTree in lib.mjs), recomputed every time it is asked about.
 */
function codeApprovalStatus(state, currentTree) {
  const approval = state.approvals.humanCodeReview
  if (!approval || !approval.approved) {
    return { status: GATE.REQUIRED, stale: false, approved: false, reason: 'a human has not approved the production diff' }
  }
  if (currentTree === undefined) {
    // The caller asked for gates without computing trees (the guard, for a call
    // that is not a publish). Report the record; nothing here grants a push.
    return { status: GATE.APPROVED, stale: false, approved: true, unchecked: true, approvedAt: approval.approvedAt }
  }
  if (!approval.tree) {
    return {
      status: GATE.STALE,
      stale: true,
      approved: false,
      reason: 'this approval was recorded by an older Dex that hashed diffs differently; read the diff and approve again',
    }
  }
  if (currentTree !== approval.tree) {
    return {
      status: GATE.STALE,
      stale: true,
      approved: false,
      approvedTree: approval.tree,
      currentTree,
      reason: 'the production code changed after human approval',
    }
  }
  return { status: GATE.APPROVED, stale: false, approved: true, approvedAt: approval.approvedAt, tree: approval.tree, baseSha: approval.baseSha }
}

/** A recorded result (verification or AI review) still applies only to the code it checked. */
function resultStillApplies(record, currentTree) {
  // undefined: trees were not computed. null: not a git repository, so there is
  // nothing to compare against and the record stands as written.
  if (currentTree === undefined || currentTree === null) return true
  return Boolean(record?.tree) && record.tree === currentTree
}

function sliceSummary(state) {
  const slices = Array.isArray(state.slices) ? state.slices : []
  const total = slices.length
  const complete = slices.filter((s) => s.status === 'complete').length
  const blocked = slices.filter((s) => s.status === 'blocked')
  const inProgress = slices.filter((s) => s.status === 'in-progress')
  const next = slices.find((s) => s.status === 'in-progress') || slices.find((s) => s.status === 'pending')
  let status
  if (total === 0) status = GATE.MISSING
  else if (blocked.length) status = GATE.BLOCKED
  else if (complete === total) status = GATE.COMPLETE
  else if (complete > 0 || inProgress.length) status = GATE.IN_PROGRESS
  else status = GATE.PENDING
  return { status, total, complete, blocked: blocked.map((s) => s.id), next: next ? next.id : null, slices }
}

/**
 * The complete gate report. Everything downstream — status output, `next`, the
 * PreToolUse guard, the PR gate — reads this and nothing else.
 */
export function computeGates(root, config, state, { trees = true } = {}) {
  const g = {}
  const dir = featureDir(root, state)
  const slug = state.feature.slug
  let treeCache
  // undefined means "not computed": the caller did not ask for tree checks.
  const currentTree = () => {
    if (!trees) return undefined
    if (treeCache === undefined) treeCache = workTree(dir, config, slug)
    return treeCache
  }
  g.intent = { status: artifactExists(root, state, 'intent') ? GATE.COMPLETE : GATE.MISSING }
  g.questions = approvalStatus(root, state, 'questions', 'questions')
  g.research = { status: artifactExists(root, state, 'research') ? GATE.COMPLETE : GATE.NOT_RUN }
  g.design = approvalStatus(root, state, 'design', 'design')
  g.structure = approvalStatus(root, state, 'structure', 'structure')
  g.plan = { status: artifactExists(root, state, 'plan') ? GATE.COMPLETE : GATE.MISSING }

  const wt = state.worktree || {}
  // Read live from config, so changing requireWorktree applies to features already in flight.
  if (!config.requireWorktree) g.worktree = { status: GATE.NOT_REQUIRED, ready: true }
  else if (wt.ready && wt.path && fs.existsSync(wt.path)) g.worktree = { status: GATE.READY, ready: true, branch: wt.branch, path: wt.path }
  else if (wt.ready) g.worktree = { status: GATE.NOT_READY, ready: false, reason: `recorded worktree path is gone: ${wt.path}` }
  else g.worktree = { status: GATE.NOT_READY, ready: false, reason: 'no isolated worktree prepared' }

  g.implementation = sliceSummary(state)

  const v = state.verification || {}
  const vRan = v.status === 'passed' || v.status === 'failed'
  const vCurrent = vRan && resultStillApplies(v, currentTree())
  g.verification = {
    status: !vRan || !vCurrent ? GATE.NOT_RUN : v.status === 'passed' ? GATE.PASS : GATE.FAIL,
    commands: v.commands || [],
    ranAt: v.ranAt || null,
    ...(vRan && !vCurrent ? { reason: 'the code changed after verification ran' } : {}),
  }

  const r = state.aiReview || {}
  const rCurrent = r.status === 'completed' && resultStillApplies(r, currentTree())
  if (!config.requireAiReview) {
    g.aiReview = { status: GATE.NOT_REQUIRED, satisfied: true, blockers: 0 }
  } else if (rCurrent && r.conclusion === 'pass') {
    g.aiReview = { status: GATE.PASS, satisfied: true, blockers: r.blockers || 0 }
  } else if (rCurrent) {
    g.aiReview = { status: GATE.REMEDIATION, satisfied: false, blockers: r.blockers || 0 }
  } else {
    g.aiReview = {
      status: GATE.NOT_RUN,
      satisfied: false,
      blockers: 0,
      ...(r.status === 'completed' ? { reason: 'the code changed after the AI review ran' } : {}),
    }
  }

  g.humanCodeReview = config.requireHumanCodeApproval
    ? codeApprovalStatus(state, currentTree())
    : { status: GATE.NOT_REQUIRED, approved: true, stale: false }

  // --- Derived permissions -------------------------------------------------
  // Fail closed: every reason to refuse is collected, and an empty list is the
  // only thing that grants permission.

  const implBlockers = []
  if (!g.questions.approved) implBlockers.push(`questions are ${g.questions.status} (${g.questions.reason ?? ''})`.trim())
  if (!g.design.approved) implBlockers.push(`design is ${g.design.status} (${g.design.reason ?? ''})`.trim())
  if (!g.structure.approved) implBlockers.push(`structure is ${g.structure.status} (${g.structure.reason ?? ''})`.trim())
  if (g.plan.status !== GATE.COMPLETE) implBlockers.push('tactical plan (06-plan.md) does not exist')
  if (!g.worktree.ready) implBlockers.push(`worktree is ${g.worktree.status} (${g.worktree.reason ?? ''})`.trim())
  if (state.blocked) implBlockers.push(`feature is blocked: ${state.blocked.reason}`)
  g.canImplement = { allowed: implBlockers.length === 0, blockers: implBlockers }

  // Publishing needs everything implementation needs: an approval that went
  // stale after the code was written still has to be looked at again.
  const prBlockers = [...implBlockers]
  if (g.implementation.status !== GATE.COMPLETE) {
    prBlockers.push(
      g.implementation.total === 0
        ? 'no implementation checkpoints are recorded'
        : `implementation is ${g.implementation.status} (${g.implementation.complete}/${g.implementation.total} checkpoints complete)`
    )
  }
  if (g.verification.status !== GATE.PASS) prBlockers.push(`verification is ${g.verification.status}`)
  if (!g.aiReview.satisfied) prBlockers.push(`AI review is ${g.aiReview.status}`)
  if (config.requireAiReview && rCurrent && (state.aiReview?.blockers || 0) > 0) {
    prBlockers.push(`${state.aiReview.blockers} unresolved BLOCKER finding(s) in the AI review`)
  }
  if (!g.humanCodeReview.approved) prBlockers.push(`human code review is ${g.humanCodeReview.status}`)
  g.canPr = { allowed: prBlockers.length === 0, blockers: prBlockers }

  // Publishing needs one more thing: HEAD must hold exactly the approved code,
  // so what leaves the machine is what the human read. Only computed with trees.
  if (trees) {
    const publishBlockers = [...prBlockers]
    if (g.canPr.allowed && config.requireHumanCodeApproval) {
      if (headTree(dir, config, slug) !== state.approvals.humanCodeReview.tree) {
        publishBlockers.push(
          'HEAD does not hold exactly the approved code. Commit the approved changes, and nothing else, then push.'
        )
      }
    }
    g.canPublish = { allowed: publishBlockers.length === 0, blockers: publishBlockers }
  }

  g.staleApprovals = ['questions', 'design', 'structure', 'humanCodeReview'].filter((k) => g[k]?.stale)

  return g
}

// ---------------------------------------------------------------------------
// Next legal action
// ---------------------------------------------------------------------------

/**
 * Deterministically name the next legal command. The model never invents this.
 */
export function nextAction(root, config, state, gates) {
  const slug = state.feature.slug
  const g = gates

  if (state.blocked) {
    const staleKey = ['questions', 'design', 'structure'].find((k) => g[k].stale)
    if (staleKey) {
      return {
        action: `reapprove-${staleKey}`,
        command: `/dex:approve ${staleKey} ${slug}`,
        why: `Feature is blocked: ${state.blocked.reason}. Re-read the revised ${staleKey} and approve it; Dex unblocks the feature once every approval is current.`,
      }
    }
    const target = state.blocked.target || 'design'
    return {
      action: 'resolve-drift',
      command: `/dex:${target} ${slug}`,
      why: `Feature is blocked: ${state.blocked.reason}. Revise the ${target}, then approve it again.`,
    }
  }
  for (const key of ['questions', 'design', 'structure']) {
    if (g[key].stale) {
      return {
        action: `reapprove-${key}`,
        command: `/dex:approve ${key} ${slug}`,
        why: `${key} changed after it was approved. Re-read it and approve the current version.`,
      }
    }
  }
  if (g.intent.status !== GATE.COMPLETE) {
    return { action: 'intent', command: `/dex:start <feature description>`, why: '01-intent.md is missing.' }
  }
  if (g.questions.status === GATE.MISSING) {
    return { action: 'questions', command: `/dex:questions ${slug}`, why: 'Research questions have not been drafted.' }
  }
  if (!g.questions.approved) {
    return {
      action: 'approve-questions',
      command: `/dex:approve questions ${slug}`,
      why: `Read ${state.artifacts.questions}, edit it freely, then approve it.`,
    }
  }
  if (g.research.status !== GATE.COMPLETE) {
    return { action: 'research', command: `/dex:research ${slug}`, why: 'Objective codebase research has not been run.' }
  }
  if (g.design.status === GATE.MISSING) {
    return { action: 'design', command: `/dex:design ${slug}`, why: 'Design discussion has not started.' }
  }
  if (!g.design.approved) {
    return {
      action: 'approve-design',
      command: `/dex:approve design ${slug}`,
      why: `A design draft exists. Read ${state.artifacts.design} — start with its least-confident decisions. Continue the discussion with /dex:design ${slug} if it is not right yet.`,
    }
  }
  if (g.structure.status === GATE.MISSING) {
    return { action: 'structure', command: `/dex:structure ${slug}`, why: 'Program structure has not been written.' }
  }
  if (!g.structure.approved) {
    return {
      action: 'approve-structure',
      command: `/dex:approve structure ${slug}`,
      why: `A structure draft exists. Read ${state.artifacts.structure} — check that the checkpoints are vertical and individually observable. Revise with /dex:structure ${slug} if not.`,
    }
  }
  if (g.plan.status !== GATE.COMPLETE) {
    return { action: 'plan', command: `/dex:plan ${slug}`, why: 'The tactical implementation plan has not been generated.' }
  }
  if (!g.worktree.ready) {
    return { action: 'worktree', command: `/dex:worktree ${slug}`, why: 'An isolated git worktree is required before implementation.' }
  }
  if (g.implementation.status !== GATE.COMPLETE) {
    const id = g.implementation.next
    return {
      action: 'implement',
      command: id ? `/dex:implement ${slug} ${id}` : `/dex:implement ${slug}`,
      why: id ? `Checkpoint ${id} is the next incomplete checkpoint.` : 'Checkpoints are not recorded yet.',
    }
  }
  if (g.verification.status !== GATE.PASS) {
    return {
      action: 'verify',
      command: `/dex:verify ${slug}`,
      why: g.verification.status === GATE.FAIL ? 'Verification failed. Fix the failure, then re-run.' : 'Full verification has not passed.',
    }
  }
  if (!g.aiReview.satisfied) {
    return {
      action: 'review',
      command: `/dex:review ${slug}`,
      why: g.aiReview.status === GATE.REMEDIATION ? 'AI review requires remediation.' : 'Independent AI review has not run.',
    }
  }
  if (!g.humanCodeReview.approved) {
    return {
      action: 'human-code-review',
      command: `/dex:approve code ${slug}`,
      why:
        g.humanCodeReview.status === GATE.STALE
          ? 'The diff changed after your approval. Read the current diff and approve again.'
          : 'Read the production diff yourself. AI review does not substitute for this.',
    }
  }
  if (!state.pr?.created) {
    return { action: 'pr', command: `/dex:pr ${slug}`, why: 'All gates are satisfied. Prepare the pull request.' }
  }
  return { action: 'complete', command: null, why: 'Pull request created. Nothing further is gated.' }
}

// ---------------------------------------------------------------------------
// Phase advancement
// ---------------------------------------------------------------------------

/**
 * Phase is a convenience label derived from the gates, not an independent truth.
 * Deriving it prevents the phase field and the gates from ever disagreeing.
 */
export function derivePhase(gates, state) {
  const g = gates
  if (state.pr?.created) return 'complete'
  if (g.humanCodeReview.approved) return 'pr'
  if (g.aiReview.satisfied && g.verification.status === GATE.PASS) return 'review'
  if (g.implementation.status === GATE.COMPLETE) return 'verify'
  if (g.worktree.ready && g.plan.status === GATE.COMPLETE && g.structure.approved) return 'implement'
  if (g.plan.status === GATE.COMPLETE && g.structure.approved) return 'worktree'
  if (g.structure.approved) return 'plan'
  if (g.design.approved) return 'structure'
  if (g.research.status === GATE.COMPLETE && g.questions.approved) return 'design'
  if (g.questions.approved) return 'research'
  if (g.intent.status === GATE.COMPLETE) return 'questions'
  return 'initialized'
}

function refreshPhase(root, config, state) {
  const gates = computeGates(root, config, state)
  state.phase = derivePhase(gates, state)
  return gates
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 22

function line(label, value) {
  return `${pad(label, LABEL_WIDTH)}${value}`
}

export function renderStatus(root, config, state, gates) {
  const g = gates
  const out = []
  out.push(`DEX: ${state.feature.slug}`)
  out.push(`${state.feature.title}`)
  out.push('')
  if (state.blocked) {
    out.push(`BLOCKED: ${state.blocked.reason}`)
    out.push(`  since ${state.blocked.since}${state.blocked.slice ? ` at checkpoint ${state.blocked.slice}` : ''}`)
    out.push('')
  }
  if (g.staleApprovals.length) {
    for (const k of g.staleApprovals) {
      const artifactKey = k === 'humanCodeReview' ? null : k
      if (artifactKey) {
        out.push(`STALE APPROVAL: ${k} changed after approval.`)
        out.push(`  Run /dex:approve ${k} ${state.feature.slug} again.`)
      } else {
        out.push('HUMAN CODE APPROVAL STALE: the diff changed after approval.')
        out.push(`  Re-read the diff, then run /dex:approve code ${state.feature.slug} again.`)
      }
    }
    out.push('')
  }
  out.push(line('Intent', g.intent.status))
  out.push(line('Questions', g.questions.status))
  out.push(line('Research', g.research.status))
  out.push(line('Design', g.design.status))
  out.push(line('Structure', g.structure.status))
  out.push(line('Plan', g.plan.status))
  out.push(line('Worktree', g.worktree.status + (g.worktree.branch ? `  (${g.worktree.branch})` : '')))
  out.push('')
  out.push('Implementation')
  if (!g.implementation.total) {
    out.push('  (no checkpoints recorded — /dex:structure defines them, /dex:plan records them)')
  } else {
    for (const s of g.implementation.slices) {
      const status = s.status === 'complete' ? 'COMPLETE' : s.status === 'in-progress' ? 'IN PROGRESS' : s.status === 'blocked' ? 'BLOCKED' : 'PENDING'
      out.push(`  ${pad(`${s.id} ${s.name || ''}`.trim(), LABEL_WIDTH - 2)}${status}`)
    }
  }
  out.push('')
  out.push(line('Verification', g.verification.status))
  out.push(line('AI Review', g.aiReview.status + (g.aiReview.blockers ? `  (${g.aiReview.blockers} blocker(s))` : '')))
  out.push(line('Human Code Review', g.humanCodeReview.status))
  out.push(line('PR', state.pr?.created ? GATE.CREATED : g.canPr.allowed ? GATE.READY : GATE.BLOCKED))
  if (!g.canPr.allowed && !state.pr?.created) {
    for (const b of g.canPr.blockers) out.push(`  - ${b}`)
  }
  const next = nextAction(root, config, state, gates)
  out.push('')
  out.push('Next:')
  out.push(next.command ? next.command : '(nothing)')
  if (next.why) out.push(`  ${next.why}`)
  if (config.__warnings?.length) {
    out.push('')
    out.push('Config warnings:')
    for (const w of config.__warnings) out.push(`  - ${w}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Flags that are switches. Every other flag must be followed by a value. */
const BOOLEAN_FLAGS = new Set(['json', 'replace', 'review'])

function parseFlags(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
      } else if (next === undefined || next.startsWith('--')) {
        throw new DexError(`--${key} needs a value.\n\nExample: --${key} "<value>"`)
      } else {
        flags[key] = next
        i++
      }
    } else {
      rest.push(a)
    }
  }
  return { flags, rest }
}

function requireSlug(slug, what) {
  if (!slug) throw new DexError(`Dex needs a feature slug.\n\nUsage: node state.mjs ${what} <feature-slug>\n\nRun "node state.mjs list" to see features.`)
  return checkSlug(slug)
}

/** Refuse anything that is not a plain feature name, before any file or folder is touched. */
function checkSlug(slug) {
  if (!isValidSlug(slug)) {
    throw new DexError(
      `"${String(slug).slice(0, 80)}" is not a valid feature name.\n\n` +
        `Feature names use lowercase letters, digits and hyphens, start with a letter or digit, and are at most 60 characters.\n\n` +
        `Run "node state.mjs list" to see features.`
    )
  }
  return slug
}

const COMMANDS = {}

COMMANDS.init = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const titleFromFlag = typeof flags.title === 'string' ? flags.title : null
  let slug = rest[0]
  const title = titleFromFlag || rest.slice(1).join(' ') || slug
  if (!slug) throw new DexError('Usage: node state.mjs init <slug> <title>')
  slug = sanitizeSlug(slug)
  if (!slug) {
    throw new DexError(
      `Dex could not make a feature name (slug) from "${rest[0]}": it has no ASCII letters or digits.\n\n` +
        `Give the slug in English, and the title as you like:\n  node state.mjs init portfolio-export --title "${rest[0]}"`
    )
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new DexError(`"${slug}" is reserved: it is the name of an approval gate. Choose another feature name.`)
  }
  const { root, config } = ctx
  ensureConfig(root)
  ignoreStateRoot(root, config)
  const statePath = path.join(featureStateDir(root, config, slug), 'state.json')
  // Check and create under the lock, so two init commands cannot both create it.
  return withFeatureLock(root, config, slug, () => {
    if (fs.existsSync(statePath)) {
      const existing = loadFeatureState(root, config, slug)
      const gates = computeGates(root, config, existing)
      return {
        text:
          `Feature "${slug}" already exists (phase ${existing.phase}).\n\n` +
          `Dex will not overwrite an in-flight feature.\n\n` +
          `Resume it:\n  /dex:resume ${slug}\n\nNext legal action:\n  ${nextAction(root, config, existing, gates).command}`,
        json: { slug, created: false, phase: existing.phase },
      }
    }
    const state = newFeatureState(slug, title, config)
    fs.mkdirSync(artifactDir(root, config, slug), { recursive: true })
    state.phase = 'initialized'
    saveFeatureState(root, config, slug, state)
    writeActiveSlug(root, config, slug)
    appendEvent(root, config, slug, 'feature_initialized', { title, artifactRoot: config.artifactRoot })
    return {
      text:
        `Initialized feature "${slug}".\n\n` +
        `Title:      ${title}\n` +
        `State:      ${normalizeRelPath(statePath, root)}\n` +
        `Artifacts:  ${config.artifactRoot}/${slug}/\n\n` +
        `Write ${state.artifacts.intent} next, then run:\n  /dex:questions ${slug}`,
      json: { slug, title, created: true, artifacts: state.artifacts },
    }
  })
}

COMMANDS.status = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0] || readActiveSlug(ctx.root, ctx.config), 'status')
  const { root, config } = ctx
  const state = loadFeatureState(root, config, slug)
  const gates = refreshPhase(root, config, state)
  if (flags.json) return { text: JSON.stringify({ state, gates }, null, 2), json: { state, gates } }
  return { text: renderStatus(root, config, state, gates), json: { state, gates } }
}

COMMANDS.check = (ctx, argv) => {
  const { rest } = parseFlags(argv)
  const slug = requireSlug(rest[0] || readActiveSlug(ctx.root, ctx.config), 'check')
  const { root, config } = ctx
  const state = loadFeatureState(root, config, slug)
  const gates = refreshPhase(root, config, state)
  const next = nextAction(root, config, state, gates)
  const payload = {
    slug,
    phase: state.phase,
    blocked: state.blocked,
    gates,
    next,
    config: { artifactRoot: config.artifactRoot, stateRoot: config.stateRoot, reviewCadence: config.reviewCadence, requireWorktree: config.requireWorktree, requireAiReview: config.requireAiReview, requireHumanCodeApproval: config.requireHumanCodeApproval, strictGates: config.strictGates, maxResearchWorkers: config.maxResearchWorkers },
    artifacts: state.artifacts,
    worktree: state.worktree,
    warnings: config.__warnings || [],
  }
  return { text: JSON.stringify(payload, null, 2), json: payload }
}

COMMANDS.next = (ctx, argv) => {
  const { rest } = parseFlags(argv)
  const slug = requireSlug(rest[0] || readActiveSlug(ctx.root, ctx.config), 'next')
  const { root, config } = ctx
  const state = loadFeatureState(root, config, slug)
  const gates = refreshPhase(root, config, state)
  const next = nextAction(root, config, state, gates)
  const text = next.command
    ? `${next.command}\n\n${next.why}`
    : `Nothing is pending for ${slug}.\n\n${next.why}`
  return { text, json: next }
}

COMMANDS.approve = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const [gate, rawSlug] = rest
  if (!RESERVED_SLUGS.has(gate)) {
    throw new DexError(
      `"${gate ?? ''}" is not an approval gate.\n\nUsage: node state.mjs approve <gate> <slug>\n\nGates: questions, design, structure, code`
    )
  }
  const slug = requireSlug(rawSlug, 'approve <gate>')
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)

    if (gate === 'code') {
      const gatesBefore = computeGates(root, config, state)
      if (gatesBefore.verification.status !== GATE.PASS && config.strictGates) {
        throw new DexError(
          `Dex will not record a human code approval while verification is ${gatesBefore.verification.status}.\n\n` +
            `Approving code that does not pass its own tests records a false engineering signal.\n\n` +
            `Run:\n  /dex:verify ${slug}`
        )
      }
      const cwd = featureDir(root, state)
      if (!isGitRepo(cwd)) {
        throw new DexError(
          `Dex cannot record the code approval because ${cwd} is not a git repository.\n\n` +
            `Human code approval is bound to a git tree. Without git there is nothing to bind to.\n\n` +
            `Initialize the repository, or set "requireHumanCodeApproval": false in ${normalizeRelPath(config.__path, root)} and accept that Dex stops enforcing this gate.`
        )
      }
      const baseSha = state.worktree?.baseSha || mergeBase(cwd, state.worktree?.base)
      if (!baseSha) {
        throw new DexError(
          `Dex cannot record the code approval because it does not know the base commit the feature started from.\n\n` +
            `Without a base there is no way to show exactly what changed.\n\n` +
            `Record the worktree with its base branch:\n  node state.mjs record-worktree ${slug} <branch> <path> --base <base-branch>`
        )
      }
      const tree = workTree(cwd, config, slug)
      if (!tree) throw new DexError(`Dex could not compute the tree of ${cwd}.`)
      if (tree === commitTree(cwd, baseSha)) {
        throw new DexError(
          `There is no production diff to approve against the base commit ${baseSha.slice(0, 12)}.\n\n` +
            `Dex refuses to record an approval of an empty change.\n\n` +
            `Check:\n  git -C ${cwd} status`
        )
      }
      state.approvals.humanCodeReview = {
        approved: true,
        approvedAt: nowIso(),
        tree,
        baseSha,
        worktree: state.worktree?.path || null,
      }
      const gates = refreshPhase(root, config, state)
      saveFeatureState(root, config, slug, state)
      appendEvent(root, config, slug, 'human_code_review_approved', { tree, baseSha })
      const next = nextAction(root, config, state, gates)
      return {
        text:
          `APPROVED: human code review\n` +
          `Feature:   ${slug}\n` +
          `Base:      ${baseSha}\n` +
          `Tree:      ${tree}\n\n` +
          `This approval covers exactly:\n  git -C ${cwd} diff ${baseSha} ${tree}\n\n` +
          `Any further production change voids it. Staging and committing do not.\n\n` +
          `Next: ${next.command ?? '(nothing)'}`,
        json: { gate: 'humanCodeReview', tree, baseSha, next },
      }
    }

    const artifactKey = gate
    const abs = artifactAbs(root, state, artifactKey)
    if (!artifactExists(root, state, artifactKey)) {
      throw new DexError(
        `Dex cannot approve ${gate}: ${state.artifacts[artifactKey]} does not exist or is empty.\n\n` +
          `Generate it first:\n  /dex:${gate === 'questions' ? 'questions' : gate} ${slug}`
      )
    }
    // Upstream gates must hold, or an approval here would rest on nothing.
    const pre = computeGates(root, config, state)
    if (gate === 'design' && !pre.questions.approved && config.strictGates) {
      throw new DexError(
        `Dex will not approve the design while questions are ${pre.questions.status}.\n\n` +
          `A design approved on top of unapproved research questions has no factual footing.\n\n` +
          `Run:\n  /dex:approve questions ${slug}`
      )
    }
    if (gate === 'structure' && !pre.design.approved && config.strictGates) {
      throw new DexError(
        `Dex will not approve the structure while the design is ${pre.design.status}.\n\n` +
          `Structure answers "how do we get there safely". Without an approved design there is no agreed destination.\n\n` +
          `Run:\n  /dex:approve design ${slug}`
      )
    }
    const hash = hashFile(abs)
    const previous = state.approvals[artifactKey]
    const upGate = UPSTREAM[artifactKey]
    state.approvals[artifactKey] = {
      approved: true,
      approvedAt: nowIso(),
      artifactHash: hash,
      ...(upGate ? { upstream: { gate: upGate, hash: state.approvals[upGate]?.artifactHash ?? null } } : {}),
    }
    // A feature blocked by drift unblocks itself once the revised documents
    // are approved again. Nothing else can unblock it.
    const unblocked = state.blocked ? tryUnblock(root, config, state).unblocked : false
    const gates = refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, `${gate}_approved`, {
      artifactHash: hash,
      artifact: state.artifacts[artifactKey],
      reapproval: Boolean(previous?.approved),
    })
    const next = nextAction(root, config, state, gates)
    return {
      text:
        `APPROVED: ${gate}\n` +
        `Feature:  ${slug}\n` +
        `Artifact: ${state.artifacts[artifactKey]}\n` +
        `SHA-256:  ${hash}\n\n` +
        `Editing that file after this point makes the approval stale.\n\n` +
        (unblocked ? `The design drift is resolved: feature unblocked.\n\n` : state.blocked ? `The feature is still blocked: ${state.blocked.reason}\n\n` : '') +
        `Next: ${next.command ?? '(nothing)'}`,
      json: { gate, artifactHash: hash, artifact: state.artifacts[artifactKey], unblocked, next },
    }
  })
}

/** Transitions that only record that a stage ran. Gates still decide everything. */
const TRANSITIONS = {
  'questions-generated': (state) => {
    state.__event = 'questions_generated'
  },
  'research-started': (state) => {
    state.__event = 'research_started'
  },
  'research-complete': (state) => {
    state.__event = 'research_completed'
  },
  'design-started': (state) => {
    state.__event = 'design_started'
  },
  'design-updated': (state) => {
    state.__event = 'design_updated'
    if (state.approvals.design?.approved) state.__note = 'design changed; its approval is now stale'
  },
  'structure-started': (state) => {
    state.__event = 'structure_started'
  },
  'plan-generated': (state) => {
    state.__event = 'plan_generated'
  },
  'verification-started': (state) => {
    state.__event = 'verification_started'
  },
  'review-started': (state) => {
    state.__event = 'ai_review_started'
  },
  'feature-completed': (state) => {
    state.__event = 'feature_completed'
  },
}

COMMANDS.transition = (ctx, argv) => {
  const { rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'transition')
  const event = rest[1]
  if (!TRANSITIONS[event]) {
    throw new DexError(`Unknown transition "${event ?? ''}".\n\nValid transitions:\n  ${Object.keys(TRANSITIONS).join('\n  ')}`)
  }
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    TRANSITIONS[event](state)
    const eventName = state.__event
    const note = state.__note
    delete state.__event
    delete state.__note
    const gates = refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    writeActiveSlug(root, config, slug)
    appendEvent(root, config, slug, eventName, {})
    const next = nextAction(root, config, state, gates)
    return {
      text: `${eventName}\nPhase: ${state.phase}${note ? `\n\nNOTE: ${note}` : ''}\n\nNext: ${next.command ?? '(nothing)'}`,
      json: { event: eventName, phase: state.phase, note: note ?? null, next },
    }
  })
}

COMMANDS['set-slices'] = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'set-slices')
  const specs = rest.slice(1)
  if (!specs.length) {
    throw new DexError(
      'Usage: node state.mjs set-slices <slug> "S1:tracer — create portfolio optimization run" "S2:happy path" ...\n\n' +
        'Each argument is <id>:<name>. Ids come from the approved structure document.'
    )
  }
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    const gates = computeGates(root, config, state)
    if (!gates.structure.approved && config.strictGates) {
      throw new DexError(
        `Dex will not record implementation checkpoints while the structure is ${gates.structure.status}.\n\n` +
          `Checkpoints come from the approved structure.\n\nRun:\n  /dex:approve structure ${slug}`
      )
    }
    if (state.pr?.created) {
      throw new DexError(
        `Dex will not change the checkpoints of "${slug}": its PR is recorded, so the feature is complete.\n\n` +
          `Start a new feature for further work:\n  /dex:start`
      )
    }
    const existing = new Map((state.slices || []).map((s) => [s.id, s]))
    const slices = specs.map((spec) => {
      const idx = spec.indexOf(':')
      const raw = (idx === -1 ? spec : spec.slice(0, idx)).trim()
      const name = idx === -1 ? '' : spec.slice(idx + 1).trim()
      const id = normalizeSliceId(raw)
      if (!id) {
        throw new DexError(`Checkpoint id "${raw}" must look like S1, S2, S3.\n\nGot: ${spec}`)
      }
      const prior = existing.get(id)
      return {
        id,
        name,
        tracer: /tracer/i.test(name),
        status: prior?.status ?? 'pending',
        startedAt: prior?.startedAt ?? null,
        completedAt: prior?.completedAt ?? null,
        verification: prior?.verification ?? null,
        note: prior?.note ?? null,
      }
    })
    const dupes = slices.map((s) => s.id).filter((id, i, a) => a.indexOf(id) !== i)
    if (dupes.length) throw new DexError(`Duplicate checkpoint ids: ${[...new Set(dupes)].join(', ')}`)
    const oldIds = [...existing.keys()].sort()
    const newIds = slices.map((s) => s.id).sort()
    // Once work has started, the list changes only after the human approves a
    // revised structure: an approval newer than the latest checkpoint start.
    const started = [...existing.values()].filter((s) => s.startedAt).map((s) => s.id)
    const latestStart = [...existing.values()].map((s) => s.startedAt).filter(Boolean).sort().at(-1)
    const approvedAt = gates.structure.approved ? gates.structure.approvedAt : null
    const unlocked = !latestStart || (approvedAt && approvedAt > latestStart)
    if (!unlocked && oldIds.join() !== newIds.join()) {
      throw new DexError(
        `Dex will not change the checkpoints of "${slug}": ${started.join(', ')} already started, ` +
          `and the structure has not been approved since.\n\n` +
          `Recorded: ${oldIds.join(', ')}\nRequested: ${newIds.join(', ')}\n\n` +
          `To change them:\n` +
          `  1. Revise ${state.artifacts.structure} with the new checkpoints.\n` +
          `  2. Ask the user to approve it: /dex:approve structure ${slug}\n` +
          `  3. Run set-slices again with the full list.\n\n` +
          `If the code contradicted the design, record that first:\n  node state.mjs drift ${slug} --target structure --reason "..."`
      )
    }
    const dropped = oldIds.filter((id) => !newIds.includes(id))
    const droppedStarted = dropped.filter((id) => started.includes(id))
    if (droppedStarted.length) {
      throw new DexError(
        `Dex will not drop ${droppedStarted.join(', ')}: already started, and the record stays.\n\n` +
          `Keep ${droppedStarted.join(', ')} in the list, even if the revised structure no longer needs it.`
      )
    }
    if (dropped.length && !flags.replace) {
      throw new DexError(
        `This would drop recorded checkpoint(s) ${dropped.join(', ')}.\n\n` +
          `If that is intended, repeat the command with --replace.`
      )
    }
    state.slices = slices
    refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, 'plan_generated', { checkpoints: slices.map((s) => s.id), tracer: slices.some((s) => s.tracer) })
    const warnings = structureWarnings(root, state, slices)
    return {
      text:
        `Recorded ${slices.length} implementation checkpoint(s):\n` +
        slices.map((s) => `  ${s.id}  ${s.name}${s.tracer ? '  [tracer]' : ''}`).join('\n') +
        (warnings.length ? `\n\nWARNING:\n${warnings.map((w) => `  - ${w}`).join('\n')}` : ''),
      json: { slices, warnings },
    }
  })
}

/**
 * Compare recorded checkpoints with the approved structure document: its
 * "Tracer bullet required:" line and the checkpoint ids it mentions.
 */
function structureWarnings(root, state, slices) {
  let text = ''
  try {
    text = fs.readFileSync(artifactAbs(root, state, 'structure'), 'utf8')
  } catch {
    return []
  }
  const warnings = []
  if (/Tracer bullet required:\s*\**\s*YES/i.test(text) && !slices.some((s) => s.tracer)) {
    warnings.push('the structure says a tracer bullet is required, but no checkpoint is named as the tracer (put "tracer" in its name)')
  }
  const inStructure = [...new Set([...text.matchAll(/\bS0*([1-9]\d*)\b/g)].map((m) => `S${m[1]}`))]
  if (inStructure.length) {
    const recorded = slices.map((s) => s.id)
    const missing = inStructure.filter((id) => !recorded.includes(id))
    const extra = recorded.filter((id) => !inStructure.includes(id))
    if (missing.length) warnings.push(`the structure names ${missing.join(', ')}, which are not recorded`)
    if (extra.length) warnings.push(`${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} recorded but not in the structure`)
  }
  return warnings
}

/** S1, s1 and S01 all name checkpoint S1. Returns null for anything else. */
function normalizeSliceId(id) {
  const m = /^S0*([1-9]\d*)$/i.exec(String(id || '').trim())
  return m ? `S${m[1]}` : null
}

function findSlice(state, id) {
  const wanted = normalizeSliceId(id) || String(id || '').toUpperCase()
  const slice = (state.slices || []).find((s) => s.id === wanted)
  if (!slice) {
    throw new DexError(
      `Feature "${state.feature.slug}" has no checkpoint "${id}".\n\n` +
        `Known checkpoints: ${(state.slices || []).map((s) => s.id).join(', ') || '(none recorded)'}\n\n` +
        `Record them from the approved structure with:\n  node state.mjs set-slices ${state.feature.slug} "S1:..." "S2:..."`
    )
  }
  return slice
}

/** Record the commit the feature started from, so every diff has a fixed base. */
function pinBase(state, dir, baseRef) {
  const sha = mergeBase(dir, baseRef)
  if (!sha) return
  state.worktree = { ...(state.worktree || {}), base: baseRef, baseSha: sha }
}

/** Verification and AI review describe finished code, so they wait for every checkpoint. */
function requireAllSlicesComplete(state, what) {
  const open = (state.slices || []).filter((s) => s.status !== 'complete').map((s) => s.id)
  if (!(state.slices || []).length || open.length) {
    throw new DexError(
      `Dex will not record ${what} yet: ${open.length ? `checkpoint(s) ${open.join(', ')} are not complete` : 'no checkpoints are recorded'}.\n\n` +
        `It has to describe the finished code. Finish the checkpoints first:\n  /dex:implement ${state.feature.slug}`
    )
  }
}

COMMANDS['start-slice'] = (ctx, argv) => {
  const { rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'start-slice')
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    const gates = computeGates(root, config, state)
    if (!gates.canImplement.allowed) {
      throw new DexError(
        `Dex blocked checkpoint ${rest[1]} because implementation gates are not satisfied:\n\n` +
          gates.canImplement.blockers.map((b) => `  - ${b}`).join('\n') +
          `\n\nRun:\n  /dex:status ${slug}`
      )
    }
    const slice = findSlice(state, rest[1])
    const earlierIncomplete = (state.slices || []).filter(
      (s) => s.status !== 'complete' && Number(s.id.slice(1)) < Number(slice.id.slice(1))
    )
    if (!config.requireWorktree && !state.worktree?.baseSha) pinBase(state, root, detectBaseBranch(root))
    slice.status = 'in-progress'
    slice.startedAt = nowIso()
    refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, 'slice_started', { slice: slice.id })
    const warn = earlierIncomplete.length
      ? `\n\nNOTE: earlier checkpoint(s) ${earlierIncomplete.map((s) => s.id).join(', ')} are not complete. Checkpoints are ordered for a reason — confirm this is deliberate.`
      : ''
    return { text: `Checkpoint ${slice.id} started: ${slice.name}${warn}`, json: { slice } }
  })
}

COMMANDS['finish-slice'] = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'finish-slice')
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    const slice = findSlice(state, rest[1])
    if (state.blocked) {
      throw new DexError(`Dex will not complete checkpoint ${slice.id}: feature "${slug}" is blocked (${state.blocked.reason}).\n\nNext:\n  /dex:status ${slug}`)
    }
    if (slice.status !== 'in-progress') {
      throw new DexError(`Checkpoint ${slice.id} is ${slice.status}, not in progress. Start it first:\n  node state.mjs start-slice ${slug} ${slice.id}`)
    }
    const allowed = computeGates(root, config, state, { trees: false }).canImplement
    if (!allowed.allowed) {
      throw new DexError(
        `Dex will not complete checkpoint ${slice.id} because implementation gates are not satisfied:\n\n` +
          allowed.blockers.map((b) => `  - ${b}`).join('\n')
      )
    }
    if (!flags.verification) {
      throw new DexError(
        `Dex will not mark checkpoint ${slice.id} complete without its verification result.\n\n` +
          `A checkpoint whose verification was never run is not a checkpoint.\n\n` +
          `Usage:\n  node state.mjs finish-slice ${slug} ${slice.id} --verification "npm test -- portfolio" --note "..."`
      )
    }
    slice.status = 'complete'
    slice.completedAt = nowIso()
    slice.verification = scrubAndClip(flags.verification, 400)
    if (typeof flags.note === 'string') slice.note = scrubAndClip(flags.note, 1000)
    const gates = refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, 'slice_implemented', { slice: slice.id, verification: slice.verification })
    const remaining = (state.slices || []).filter((s) => s.status !== 'complete')
    const next = nextAction(root, config, state, gates)
    const cadenceNote =
      config.reviewCadence === 'slice'
        ? `\n\nreviewCadence is "slice": a human should read this checkpoint's diff before the next one starts.`
        : config.reviewCadence === 'checkpoint' && slice.tracer
          ? `\n\nreviewCadence is "checkpoint" and this was the tracer: a human should read the diff before deepening.`
          : ''
    return {
      text:
        `Checkpoint ${slice.id} COMPLETE: ${slice.name}\n` +
        `Verification: ${slice.verification}\n` +
        `Remaining: ${remaining.map((s) => s.id).join(', ') || '(none)'}${cadenceNote}\n\n` +
        `Next: ${next.command ?? '(nothing)'}`,
      json: { slice, remaining: remaining.map((s) => s.id), next },
    }
  })
}

COMMANDS['block-slice'] = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'block-slice')
  if (!flags.reason) throw new DexError(`Usage: node state.mjs block-slice ${slug} <id> --reason "what blocks it"`)
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    const slice = findSlice(state, rest[1])
    slice.status = 'blocked'
    slice.note = scrubAndClip(flags.reason, 1000)
    refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, 'slice_blocked', { slice: slice.id, reason: slice.note })
    return { text: `Checkpoint ${slice.id} BLOCKED: ${slice.note}`, json: { slice } }
  })
}

COMMANDS.verification = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'verification')
  const result = rest[1]
  if (!['pass', 'fail', 'reset'].includes(result)) {
    throw new DexError(
      `Usage: node state.mjs verification <slug> <pass|fail|reset> [--command "cmd" --exit 0]...\n\n` +
        `Pass --commands-json '[{"command":"npm test","exitCode":0}]' to record several at once.`
    )
  }
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    let commands = []
    if (typeof flags['commands-json'] === 'string') {
      try {
        commands = JSON.parse(flags['commands-json'])
      } catch (err) {
        throw new DexError(`--commands-json is not valid JSON: ${err.message}`)
      }
      if (!Array.isArray(commands)) throw new DexError('--commands-json must be a JSON array.')
    } else if (typeof flags.command === 'string') {
      commands = [{ command: flags.command, exitCode: flags.exit === undefined ? null : Number(flags.exit) }]
    }
    commands = commands.map((c) => ({
      command: scrubAndClip(c.command ?? '', 400),
      exitCode: c.exitCode === null || c.exitCode === undefined ? null : Number(c.exitCode),
      category: c.category ? String(c.category).slice(0, 40) : null,
      summary: c.summary ? scrubAndClip(c.summary, 600) : null,
    }))
    if (result === 'reset') {
      state.verification = { status: 'not-run', commands: [], lastResult: null, ranAt: null }
    } else {
      requireAllSlicesComplete(state, 'verification')
      if (!commands.length) {
        throw new DexError(
          `Dex will not record verification ${result} with no commands.\n\n` +
            `Verification means "these exact commands ran and this is what they returned".\n\n` +
            `Usage:\n  node state.mjs verification ${slug} ${result} --command "./gradlew test" --exit 0`
        )
      }
      const failing = commands.filter((c) => c.exitCode !== 0)
      if (result === 'pass' && failing.length) {
        throw new DexError(
          `Dex refuses to record verification PASS while ${failing.length} command(s) reported a non-zero exit code:\n\n` +
            failing.map((c) => `  exit ${c.exitCode}: ${c.command}`).join('\n') +
            `\n\nA deterministic failure outranks any model's judgment that the code is fine. Record it as failed, fix it, then re-run.`
        )
      }
      state.verification = {
        status: result === 'pass' ? 'passed' : 'failed',
        commands,
        lastResult: typeof flags.summary === 'string' ? scrubAndClip(flags.summary, 2000) : null,
        ranAt: nowIso(),
        tree: workTree(featureDir(root, state), config, slug),
      }
    }
    const gates = refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    if (result !== 'reset') {
      appendEvent(root, config, slug, result === 'pass' ? 'verification_passed' : 'verification_failed', {
        commands: commands.map((c) => ({ command: c.command, exitCode: c.exitCode })),
      })
    }
    const next = nextAction(root, config, state, gates)
    return {
      text: `Verification: ${state.verification.status.toUpperCase()}\n` + commands.map((c) => `  exit ${c.exitCode}  ${c.command}`).join('\n') + `\n\nNext: ${next.command ?? '(nothing)'}`,
      json: { verification: state.verification, next },
    }
  })
}

COMMANDS['record-review'] = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'record-review')
  const conclusion = rest[1]
  if (!['pass', 'remediation-required'].includes(conclusion)) {
    throw new DexError(`Usage: node state.mjs record-review <slug> <pass|remediation-required> [--blockers N] [--high N]`)
  }
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    const blockers = flags.blockers === undefined ? 0 : Number(flags.blockers)
    if (!Number.isInteger(blockers) || blockers < 0) throw new DexError('--blockers must be a non-negative integer.')
    if (conclusion === 'pass' && blockers > 0) {
      throw new DexError(`An AI review with ${blockers} BLOCKER finding(s) cannot conclude PASS. Record it as remediation-required.`)
    }
    requireAllSlicesComplete(state, 'the AI review')
    state.aiReview = {
      status: 'completed',
      conclusion,
      blockers,
      high: flags.high === undefined ? null : Number(flags.high),
      completedAt: nowIso(),
      tree: workTree(featureDir(root, state), config, slug),
    }
    const gates = refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, 'ai_review_completed', { conclusion, blockers })
    const next = nextAction(root, config, state, gates)
    return {
      text:
        `AI review recorded: ${conclusion.toUpperCase()} (${blockers} blocker(s))\n\n` +
        `AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW. It never records a human approval.\n\n` +
        `Next: ${next.command ?? '(nothing)'}`,
      json: { aiReview: state.aiReview, next },
    }
  })
}

/** The repository's worktrees, main checkout first, from `git worktree list --porcelain`. */
function listWorktrees(root) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd: root, allowFail: true }) || ''
  return out
    .split('\n\n')
    .map((block) => {
      const entry = {}
      for (const line of block.split('\n')) {
        const [key, ...value] = line.split(' ')
        if (key) entry[key] = value.join(' ')
      }
      return entry
    })
    .filter((e) => e.worktree)
}

function realpath(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** Refuse anything but a linked worktree of this repository, on the named branch. */
function checkWorktree(root, abs, branch) {
  const worktrees = listWorktrees(root)
  const target = realpath(abs)
  const index = worktrees.findIndex((w) => realpath(w.worktree) === target)
  if (index === 0) {
    throw new DexError(`Dex will not record ${abs} as the feature worktree because it is the main checkout.\n\nCreate a separate worktree with /dex:worktree.`)
  }
  if (index === -1) {
    throw new DexError(`Dex will not record ${abs} because it is not a worktree of this repository.\n\nCreate it with: git worktree add <path> -b ${branch}`)
  }
  const actual = (worktrees[index].branch || '').replace(/^refs\/heads\//, '')
  if (actual !== branch) {
    throw new DexError(`The worktree at ${abs} is on branch "${actual || '(detached)'}", not "${branch}".\n\nRecord it with its real branch name.`)
  }
}

/** Refuse a base that would hide the feature's own commits from the code approval. */
function checkBase(abs, base, branch) {
  if (!base) return
  if (base === 'HEAD' || base === branch || base === `refs/heads/${branch}`) {
    throw new DexError(`"${base}" cannot be the base: it is the feature branch itself, so the feature's commits would never show up in the diff.\n\nUse the branch the feature started from, such as main.`)
  }
  if (!git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: abs, allowFail: true })) {
    throw new DexError(`The base "${base}" does not name a commit in this repository.`)
  }
}

COMMANDS['record-worktree'] = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'record-worktree')
  const branch = rest[1]
  const wtPath = rest[2]
  if (!branch || !wtPath) throw new DexError(`Usage: node state.mjs record-worktree <slug> <branch> <path> [--base <ref>]`)
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    const abs = path.resolve(wtPath)
    if (!fs.existsSync(abs)) {
      throw new DexError(`Dex will not record a worktree at ${abs} because that path does not exist.\n\nCreate it first, then record it.`)
    }
    checkWorktree(root, abs, branch)
    const base = typeof flags.base === 'string' ? flags.base : detectBaseBranch(abs) || null
    checkBase(abs, base, branch)
    state.worktree = { ready: true, branch, path: abs, base, baseSha: mergeBase(abs, base) }
    const gates = refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, 'worktree_created', { branch, path: abs, base: state.worktree.base })
    const next = nextAction(root, config, state, gates)
    return {
      text: `Worktree recorded.\n  branch: ${branch}\n  path:   ${abs}\n  base:   ${state.worktree.base ?? '(none detected)'}\n\nNext: ${next.command ?? '(nothing)'}`,
      json: { worktree: state.worktree, next },
    }
  })
}

COMMANDS['record-pr'] = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'record-pr')
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    const gates = computeGates(root, config, state)
    if (!gates.canPr.allowed) {
      throw new DexError(
        `Dex blocked the pull request. Unsatisfied requirements:\n\n` +
          gates.canPr.blockers.map((b) => `  - ${b}`).join('\n') +
          `\n\nRun:\n  /dex:status ${slug}`
      )
    }
    state.pr = { created: true, url: typeof flags.url === 'string' ? flags.url : null, createdAt: nowIso() }
    refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, 'pr_created', { url: state.pr.url })
    appendEvent(root, config, slug, 'feature_completed', {})
    return { text: `PR recorded${state.pr.url ? `: ${state.pr.url}` : ''}\nFeature "${slug}" is complete.`, json: { pr: state.pr } }
  })
}

const DRIFT_TARGETS = ['design', 'structure']

COMMANDS.drift = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'drift')
  const usage = `Usage: node state.mjs drift <slug> --target design|structure --reason "what the repository shows that the design assumed otherwise" [--slice S2]`
  if (!flags.reason) throw new DexError(usage)
  if (!DRIFT_TARGETS.includes(flags.target)) {
    throw new DexError(`--target must be design (the destination changed) or structure (only the route changed).\n\n${usage}`)
  }
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    const slice = flags.slice === undefined ? null : findSlice(state, flags.slice)
    state.blocked = {
      reason: scrubAndClip(flags.reason, 1000),
      target: flags.target,
      slice: slice ? slice.id : null,
      since: nowIso(),
      kind: 'design-drift',
    }
    if (slice) {
      slice.status = 'blocked'
      slice.blockedBy = 'drift'
    }
    refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    appendEvent(root, config, slug, 'design_drift_recorded', { target: flags.target, slice: state.blocked.slice, reason: state.blocked.reason })
    return {
      text:
        `DESIGN DRIFT recorded. Feature "${slug}" is blocked.\n\n` +
        `Reason: ${state.blocked.reason}\n\n` +
        `Record the evidence in ${state.artifacts.implementationLog}, then revise the ${flags.target}:\n` +
        `  /dex:${flags.target} ${slug}\n\n` +
        `When the user approves the revised documents again, Dex unblocks the feature by itself.`,
      json: { blocked: state.blocked },
    }
  })
}

/**
 * Clear a drift block, but only once the revision has been approved: the
 * drift's target has an approval newer than the drift, and every document
 * approval is current. Resets only the checkpoint the drift blocked.
 * Mutates `state`; returns { unblocked, reasons }.
 */
function tryUnblock(root, config, state) {
  const was = state.blocked
  if (!was) return { unblocked: false, reasons: ['the feature is not blocked'] }
  const gates = computeGates(root, config, state, { trees: false })
  const reasons = []
  for (const k of ['questions', 'design', 'structure']) {
    if (!gates[k].approved) reasons.push(`${k} is ${gates[k].status}: /dex:approve ${k} ${state.feature.slug}`)
  }
  const target = was.target || 'design'
  const approvedAt = state.approvals[target]?.approvedAt
  if (!approvedAt || approvedAt <= was.since) {
    reasons.push(`the ${target} has not been approved since the drift: revise it, then /dex:approve ${target} ${state.feature.slug}`)
  }
  if (reasons.length) return { unblocked: false, reasons }
  state.blocked = null
  for (const s of state.slices || []) {
    if (s.status === 'blocked' && s.blockedBy === 'drift') {
      s.status = s.startedAt ? 'in-progress' : 'pending'
      delete s.blockedBy
    }
  }
  appendEvent(root, config, state.feature.slug, 'drift_resolved', { previousReason: was.reason, target })
  return { unblocked: true, reasons: [] }
}

COMMANDS.unblock = (ctx, argv) => {
  const { rest } = parseFlags(argv)
  const slug = requireSlug(rest[0], 'unblock')
  const { root, config } = ctx
  return withFeatureLock(root, config, slug, () => {
    const state = loadFeatureState(root, config, slug)
    if (!state.blocked) return { text: `Feature "${slug}" is not blocked.`, json: { blocked: null } }
    const { unblocked, reasons } = tryUnblock(root, config, state)
    if (!unblocked) {
      throw new DexError(
        `Dex will not unblock "${slug}" yet. The drift is resolved by a revision the user has approved:\n\n` +
          reasons.map((r) => `  - ${r}`).join('\n')
      )
    }
    const after = refreshPhase(root, config, state)
    saveFeatureState(root, config, slug, state)
    return { text: `Feature "${slug}" unblocked.\nPhase: ${state.phase}\n\nNext: ${nextAction(root, config, state, after).command ?? '(nothing)'}`, json: { phase: state.phase } }
  })
}

COMMANDS.active = (ctx, argv) => {
  const { rest } = parseFlags(argv)
  const { root, config } = ctx
  if (rest[0]) {
    checkSlug(rest[0])
    loadFeatureState(root, config, rest[0])
    writeActiveSlug(root, config, rest[0])
    return { text: `Active feature set to "${rest[0]}".`, json: { active: rest[0] } }
  }
  const resolved = resolveActiveFeature(root, config)
  if (resolved.ambiguous) {
    return {
      text: `Several features are active and none is marked current:\n  ${resolved.candidates.join('\n  ')}\n\nChoose one:\n  node state.mjs active <slug>`,
      json: resolved,
    }
  }
  return { text: resolved.slug ?? '(no active feature)', json: { active: resolved.slug } }
}

COMMANDS.list = (ctx) => {
  const { root, config } = ctx
  const features = listFeatures(root, config)
  if (!features.length) return { text: 'No Dex features in this repository.\n\nStart one:\n  /dex:start <feature description>', json: { features: [] } }
  const active = readActiveSlug(root, config)
  const rows = features.map((f) => {
    const gates = computeGates(root, config, f.state)
    const flags = []
    if (gates.staleApprovals.length) flags.push(`STALE:${gates.staleApprovals.join(',')}`)
    if (f.state.blocked) flags.push('BLOCKED')
    if (f.slug === active) flags.push('active')
    return `  ${pad(f.slug, 34)}${pad(derivePhase(gates, f.state), 14)}${flags.join(' ')}`
  })
  return { text: `DEX FEATURES\n\n${rows.join('\n')}`, json: { features: features.map((f) => ({ slug: f.slug, phase: f.phase })) } }
}

COMMANDS.config = (ctx) => {
  const { root, config } = ctx
  const shown = { ...config }
  delete shown.__warnings
  delete shown.__path
  delete shown.__exists
  const warn = config.__warnings?.length ? `\n\nWarnings:\n${config.__warnings.map((w) => `  - ${w}`).join('\n')}` : ''
  return {
    text: `Config: ${normalizeRelPath(config.__path, root)}${config.__exists ? '' : ' (not present — using defaults)'}\n\n${JSON.stringify(shown, null, 2)}${warn}`,
    json: shown,
  }
}

COMMANDS['diff-hash'] = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const { root, config } = ctx
  const slug = requireSlug(rest[0] || readActiveSlug(root, config), 'diff-hash')
  const state = loadFeatureState(root, config, slug)
  const dir = featureDir(root, state)
  const tree = workTree(dir, config, slug)
  const baseSha = state.worktree?.baseSha || null
  const json = { dir, baseSha, tree }
  if (flags.json) return { text: JSON.stringify(json), json }
  return {
    text: `dir:    ${dir}\nbase:   ${baseSha ?? '(not pinned)'}\ntree:   ${tree ?? '(none)'}` + (baseSha && tree ? `\n\nRead it:\n  git -C ${dir} diff ${baseSha} ${tree}` : ''),
    json,
  }
}

COMMANDS['stage-workflow'] = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const name = rest[0]
  const { path: staged } = stageWorkflow(ctx.root, ctx.config, name, { cwd: ctx.cwd })
  const json = { name, path: staged }
  return { text: flags.json ? JSON.stringify(json) : staged, json }
}

COMMANDS['install-hook'] = (ctx) => {
  const { file } = installPrePushHook(ctx.root)
  return {
    text: `Dex pre-push hook installed at ${file}.\n\nIt checks Dex's gates before any dex/* branch is pushed. Other branches pass untouched.`,
    json: { file },
  }
}

COMMANDS.events = (ctx, argv) => {
  const { flags, rest } = parseFlags(argv)
  const slug = requireSlug(rest[0] || readActiveSlug(ctx.root, ctx.config), 'events')
  const { root, config } = ctx
  const limit = flags.limit ? Number(flags.limit) : 40
  const all = readEvents(root, config, slug)
  const tail = all.slice(-limit)
  return {
    text: tail.map((e) => `${e.timestamp ?? '?'}  ${e.event}${e.details && Object.keys(e.details).length ? '  ' + JSON.stringify(e.details) : ''}`).join('\n') || '(no events)',
    json: { events: tail },
  }
}


// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function run(argv, { cwd = process.cwd() } = {}) {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help') {
    return {
      text:
        `Dex state machine\n\nCommands:\n  ` +
        Object.keys(COMMANDS).sort().join('\n  ') +
        `\n\nEvery gate decision lives here, not in a prompt.`,
      json: { commands: Object.keys(COMMANDS).sort() },
    }
  }
  const handler = COMMANDS[command]
  if (!handler) {
    throw new DexError(`Unknown command "${command}".\n\nValid commands:\n  ${Object.keys(COMMANDS).sort().join('\n  ')}`)
  }
  const root = findRepoRoot(cwd)
  const config = loadConfig(root)
  return handler({ root, config, cwd }, rest)
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
if (isMain) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write((result.text ?? '') + '\n')
    process.exit(0)
  } catch (err) {
    if (err instanceof DexError) {
      process.stderr.write(err.message + '\n')
      process.exit(err.exitCode)
    }
    process.stderr.write(`Dex internal error: ${err.stack || err.message}\n`)
    process.exit(1)
  }
}
