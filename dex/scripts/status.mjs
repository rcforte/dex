#!/usr/bin/env node
/**
 * dex/scripts/status.mjs
 *
 * Thin operational front-end over the state machine's gate report.
 *
 * Two modes:
 *   node status.mjs [<slug>]            terse lifecycle board
 *   node status.mjs [<slug>] --review   the same board plus the exact commands
 *                                       a human should run to read the diff
 *
 * All gate logic lives in state.mjs. This file only renders.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  DexError,
  findRepoRoot,
  git,
  isGitRepo,
  listFeatures,
  loadConfig,
  loadFeatureState,
  readActiveSlug,
  workTree,
} from './lib.mjs'
import { computeGates, featureDir, nextAction, renderStatus } from './state.mjs'

/**
 * The human code-review helper. Dex cannot read code for the engineer, so it
 * hands over an ordered, concrete reading list instead of a vague instruction.
 */
function reviewGuide(root, config, state) {
  const cwd = featureDir(root, state)
  const slug = state.feature.slug
  const baseSha = state.worktree?.baseSha || null
  const tree = baseSha ? workTree(cwd, config, slug) : null
  const lines = []
  lines.push('')
  lines.push('READ THE PRODUCTION CODE')
  lines.push('')
  lines.push('Dex cannot do this part. AI review and green tests are supplemental evidence;')
  lines.push('they are not an approval. Start with shape, then read every changed file.')
  lines.push('')
  if (!baseSha || !tree) {
    lines.push('Dex does not know the base commit yet, so it cannot show the diff.')
    lines.push(`Record the worktree first: /dex:worktree ${slug}`)
    return lines.join('\n')
  }
  lines.push('This is exactly what /dex:approve code will cover:')
  lines.push('')
  lines.push(`  git -C ${cwd} diff --stat ${baseSha} ${tree}`)
  lines.push(`  git -C ${cwd} diff ${baseSha} ${tree}`)
  lines.push('')

  {
    const nameStatus = git(['--no-pager', 'diff', '--name-status', '-M', baseSha, tree], { cwd, allowFail: true }) ?? ''
    const entries = nameStatus
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [st, ...files] = l.split(/\t/)
        return { status: st, files }
      })
    const changed = entries.filter((e) => !e.status.startsWith('A')).map((e) => ({ status: e.status, file: e.files.join(' -> ') }))
    const newFiles = entries.filter((e) => e.status.startsWith('A')).map((e) => e.files[0])

    // Buckets that historically hide the expensive mistakes.
    const sensitive = {
      'Public API / boundary': /(controller|resource|handler|route|endpoint|api|graphql|proto|openapi|\.proto$|schema\.graphql)/i,
      'Schema / migration': /(migration|migrate|schema|liquibase|flyway|\.sql$|alembic)/i,
      'Security / authorization': /(auth|security|permission|role|policy|token|crypt|secret|cors|csrf)/i,
      'Transactions / concurrency': /(transaction|@transactional|lock|concurren|async|thread|queue|consumer|producer)/i,
      'Configuration': /(config|\.ya?ml$|\.properties$|\.toml$|\.env|Dockerfile|helm|terraform)/i,
      'Tests': /(test|spec|__tests__|\.feature$)/i,
    }

    if (changed.length || newFiles.length) {
      lines.push(`Changed files (${changed.length} modified, ${newFiles.length} new):`)
      for (const c of changed) lines.push(`  ${c.status}  ${c.file}`)
      for (const f of newFiles) lines.push(`  NEW ${f}`)
      lines.push('')
      const all = [...changed.map((c) => c.file), ...newFiles]
      for (const [label, re] of Object.entries(sensitive)) {
        const hits = all.filter((f) => re.test(f))
        if (hits.length) lines.push(`${label}: ${hits.join(', ')}`)
      }
      lines.push('')
      lines.push('For each file ask:')
      lines.push('  - Does this match the design I approved, or did it drift?')
      lines.push('  - What happens on the failure path?')
      lines.push('  - Would I have written this, and would I defend it in review?')
      lines.push('  - What is NOT here that should be?')
    } else {
      lines.push(`No production changes against the base commit ${baseSha}.`)
    }
  }
  lines.push('')
  lines.push(`When you have actually read it:`)
  lines.push(`  /dex:approve code ${slug}`)
  return lines.join('\n')
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const wantReview = argv.includes('--review')
  const wantJson = argv.includes('--json')
  const positional = argv.filter((a) => !a.startsWith('--'))
  const root = findRepoRoot(cwd)
  const config = loadConfig(root)
  let slug = positional[0] || readActiveSlug(root, config)

  if (!slug) {
    const features = listFeatures(root, config)
    if (!features.length) {
      return {
        text:
          'No Dex features in this repository.\n\n' +
          'Dex is for changes worth this much ceremony: multi-file features, new endpoints,\n' +
          'schema changes, cross-layer behavior, significant refactors, complex bugs.\n\n' +
          'For a typo or a one-line fix, just make the change.\n\n' +
          'Start a feature:\n  /dex:start <feature description>',
        ok: true,
      }
    }
    const active = features.filter((f) => f.phase !== 'complete')
    if (active.length === 1) slug = active[0].slug
    else {
      return {
        text:
          `Several Dex features exist. Name one:\n\n` +
          features.map((f) => `  /dex:status ${f.slug}    (${f.phase})`).join('\n'),
        ok: true,
      }
    }
  }

  const state = loadFeatureState(root, config, slug)
  const gates = computeGates(root, config, state)
  if (wantJson) {
    const next = nextAction(root, config, state, gates)
    return { text: JSON.stringify({ slug, gates, next }, null, 2), ok: true }
  }
  let text = renderStatus(root, config, state, gates)
  const needsHumanRead =
    !gates.humanCodeReview.approved &&
    gates.implementation.status === 'COMPLETE' &&
    gates.verification.status === 'PASS'
  if (wantReview || needsHumanRead) text += '\n' + reviewGuide(root, config, state)
  return { text, ok: true }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
if (isMain) {
  try {
    const r = run(process.argv.slice(2))
    process.stdout.write(r.text + '\n')
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
