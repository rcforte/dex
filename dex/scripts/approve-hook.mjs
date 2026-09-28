#!/usr/bin/env node
/**
 * dex/scripts/approve-hook.mjs
 *
 * UserPromptSubmit hook: records a human approval.
 *
 * Why this exists: an approval means a human decided. The model must not be
 * able to record one, so the guard refuses `state.mjs approve` from the Bash
 * tool. This hook is the other half. Claude Code runs it with the text the user
 * typed, before the model sees it, and only for text the user typed. When that
 * text is exactly `/dex:approve <gate> <slug>`, the hook records the approval
 * and tells the model what happened.
 *
 * It never blocks the prompt. Anything that is not an approve command passes
 * through untouched, with no output.
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { run } from './state.mjs'

const APPROVE = /^\s*\/dex:approve\s+(questions|design|structure|code)\s+([a-z0-9][a-z0-9-]*)\s*$/

/**
 * Handle one prompt. Returns the text to add to the model's context, or null
 * when the prompt is not an approve command.
 */
export function handlePrompt(prompt, cwd) {
  const m = APPROVE.exec(String(prompt ?? ''))
  if (!m) return null
  const [, gate, slug] = m
  try {
    const result = run(['approve', gate, slug], { cwd })
    return (
      `Dex recorded the ${gate} approval for "${slug}" because the user typed /dex:approve.\n\n` +
      `${result.text ?? ''}`.trim()
    )
  } catch (err) {
    return (
      `Dex did not record the ${gate} approval for "${slug}".\n\n` +
      `${err.message}\n\n` +
      `Nothing was approved. Relay this to the user; do not try to approve another way.`
    )
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
if (isMain) {
  let payload = {}
  try {
    payload = JSON.parse(readStdin() || '{}')
  } catch {
    process.exit(0)
  }
  const context = handlePrompt(payload.prompt, payload.cwd || process.cwd())
  if (context) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }) + '\n'
    )
  }
  process.exit(0)
}
