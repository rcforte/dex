#!/usr/bin/env node
/**
 * dex/scripts/pre-push.mjs
 *
 * git pre-push hook: the backstop for the publish gate.
 *
 * Why this exists: the PreToolUse guard reads command lines, and no reading of
 * a command line catches every way to run `git push` (a script file, an
 * interpreter, a Makefile). git itself runs this hook before any push, however
 * it was started. For each ref pushed to a dex/* branch, it checks the owning
 * feature's publish gates and that the pushed commit holds exactly the code the
 * human approved. Pushes of any other branch pass untouched.
 *
 * git passes one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { findRepoRoot, headTree, listFeatures, loadConfig } from './lib.mjs'
import { computeGates, featureDir } from './state.mjs'

const ZERO = /^0+$/

/**
 * Check one push. Returns a list of problems; empty means the push may go.
 * `lines` is git's stdin, split into lines.
 */
export function checkPush(lines, { cwd = process.cwd() } = {}) {
  const refs = lines
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map(([localRef, localSha, remoteRef]) => ({ localRef, localSha, remoteRef }))
    .filter((r) => r.remoteRef.startsWith('refs/heads/dex/') && !ZERO.test(r.localSha))
  if (!refs.length) return []

  const root = findRepoRoot(cwd)
  const config = loadConfig(root)
  const features = listFeatures(root, config)
  const problems = []
  for (const ref of refs) {
    const branch = ref.remoteRef.slice('refs/heads/'.length)
    const localBranch = ref.localRef.replace(/^refs\/heads\//, '')
    const feature = features.find((f) => [branch, localBranch].includes(f.state.worktree?.branch))
    if (!feature) {
      problems.push(`${branch}: no Dex feature records this branch, so Dex cannot check what is being pushed.`)
      continue
    }
    const { slug, state } = feature
    const gates = computeGates(root, config, state)
    if (!gates.canPr.allowed) {
      problems.push(`${branch} (feature "${slug}"):\n${gates.canPr.blockers.map((b) => `    - ${b}`).join('\n')}`)
      continue
    }
    const approved = state.approvals.humanCodeReview?.tree
    if (config.requireHumanCodeApproval && headTree(featureDir(root, state), config, slug, ref.localSha) !== approved) {
      problems.push(`${branch} (feature "${slug}"): the pushed commit does not hold exactly the approved code.`)
    }
  }
  return problems
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
})()

if (isMain) {
  let problems
  try {
    problems = checkPush(fs.readFileSync(0, 'utf8').split('\n'))
  } catch (err) {
    problems = [`Dex could not check this push: ${String(err.message).split('\n')[0]}`]
  }
  if (problems.length) {
    process.stderr.write(`Dex refused this push.\n\n${problems.map((p) => `  ${p}`).join('\n')}\n\nSee: /dex:status\n`)
    process.exit(1)
  }
  process.exit(0)
}
