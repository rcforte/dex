/**
 * Static tests over the plugin's own files.
 *
 * Workflow scripts run inside an injected runtime with no filesystem access, so
 * they cannot be imported here. What can be checked statically is checked: that
 * they parse, that their metadata is well formed, and — most importantly — that
 * the research workers are driven by questions and never handed the feature
 * ticket. That last property is the whole reason research is a separate stage,
 * and it is exactly the kind of thing that erodes silently during edits.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { PLUGIN_ROOT } from './helpers.mjs'
import { WORKFLOW_NAMES } from '../scripts/lib.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const WORKFLOWS = WORKFLOW_NAMES.map((name) => `${name}.js`)

function workflowSource(file) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, 'workflows', file), 'utf8')
}

/**
 * Read a file with all whitespace collapsed to single spaces.
 *
 * Prose in markdown and in multi-line prompt arrays is hard-wrapped, so an
 * assertion about wording must not depend on where the lines happen to break.
 */
function prose(...segments) {
  return (
    fs
      .readFileSync(path.join(PLUGIN_ROOT, ...segments), 'utf8')
      // Stitch the elements of a multi-line JS string array back into flowing
      // prose, then collapse whitespace. Punctuation is preserved, because the
      // assertions are about wording and a comma is part of the wording.
      .replace(/',\s*\n\s*'/g, ' ')
      .replace(/'\s*\+\s*\n\s*'/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function skillProse(name) {
  return prose('skills', name, 'SKILL.md')
}

/** Evaluate just the meta literal, without running the script body. */
function workflowMeta(file) {
  const src = workflowSource(file)
  const m = src.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/)
  assert.ok(m, `${file} must export a meta object literal`)
  return new Function(`return ${m[1]}`)()
}

// ---------------------------------------------------------------------------
// Workflow structure
// ---------------------------------------------------------------------------

test('both workflow files exist and parse as async function bodies', () => {
  for (const file of WORKFLOWS) {
    const abs = path.join(PLUGIN_ROOT, 'workflows', file)
    assert.ok(fs.existsSync(abs), `${file} must exist`)
    const src = fs.readFileSync(abs, 'utf8')
    assert.doesNotThrow(
      () => new AsyncFunction(src.replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =')),
      `${file} must parse the way the workflow runtime evaluates it`
    )
  }
})

test('each workflow exports meta with a name and a one-line description', () => {
  for (const file of WORKFLOWS) {
    const meta = workflowMeta(file)
    assert.equal(typeof meta.name, 'string')
    assert.ok(meta.name.length > 0, `${file} meta.name must not be empty`)
    assert.equal(typeof meta.description, 'string')
    assert.ok(meta.description.length > 10, `${file} needs a real description`)
    assert.doesNotMatch(meta.description, /\n/, `${file} description must be one line`)
  }
})

test('workflow names are unique', () => {
  const names = WORKFLOWS.map((f) => workflowMeta(f).name)
  assert.equal(new Set(names).size, names.length, `duplicate workflow names: ${names.join(', ')}`)
  assert.deepEqual(names.sort(), ['dex-research', 'dex-review'])
})

test('meta.phases titles match the phase() calls in the script', () => {
  for (const file of WORKFLOWS) {
    const meta = workflowMeta(file)
    const src = workflowSource(file)
    assert.ok(Array.isArray(meta.phases), `${file} should declare phases`)
    const declared = meta.phases.map((p) => p.title)
    const called = [...src.matchAll(/(?:^|\s)phase\('([^']+)'\)/g)].map((m) => m[1])
    for (const title of called) {
      assert.ok(declared.includes(title), `${file}: phase('${title}') has no matching meta.phases entry`)
    }
    for (const p of meta.phases) {
      assert.equal(typeof p.title, 'string')
      assert.ok(p.title.length > 0)
    }
  }
})

test('workflows use only the runtime APIs the tool provides', () => {
  for (const file of WORKFLOWS) {
    const src = workflowSource(file)
    // These would throw at runtime: scripts have no filesystem or Node access,
    // and the non-deterministic clock/random are blocked so resume stays sound.
    assert.doesNotMatch(src, /\brequire\s*\(/, `${file} must not use require()`)
    assert.doesNotMatch(src, /^\s*import\s/m, `${file} must not import modules`)
    assert.doesNotMatch(src, /\bDate\.now\s*\(/, `${file} must not call Date.now()`)
    assert.doesNotMatch(src, /\bMath\.random\s*\(/, `${file} must not call Math.random()`)
    assert.doesNotMatch(src, /\bnew Date\s*\(\s*\)/, `${file} must not call new Date()`)
    assert.doesNotMatch(src, /\bprocess\./, `${file} must not touch process`)
    // Plain JavaScript only — no TypeScript annotations.
    assert.doesNotMatch(src, /^\s*(?:interface|type)\s+\w+\s*[={]/m, `${file} must be plain JavaScript`)
  }
})

// ---------------------------------------------------------------------------
// Context isolation — the invariant this workflow exists to protect
// ---------------------------------------------------------------------------

test('the research workflow never references the feature intent artifact', () => {
  const src = workflowSource('research.js')
  assert.doesNotMatch(src, /01-intent/, 'research workers must not be given the feature intent')
  assert.doesNotMatch(src, /intentPath/, 'research must not carry an intent path at all')
  assert.doesNotMatch(src, /feature (?:request|description|ticket)['"`]\s*:/i)
})

test('the research probe prompt is built from a question, not from the feature', () => {
  const src = workflowSource('research.js')
  // The probe prompt must interpolate the question and say so explicitly.
  assert.match(src, /Investigate this question in the current repository/)
  assert.match(src, /question\.question/, 'the probe prompt must interpolate the question text')
  // And it must carry the prohibitions that keep it objective.
  for (const rule of [
    /not been told what anyone wants to build/i,
    /must not try to infer it/i,
    /Do not propose a feature implementation/,
    /Do not recommend an architecture/,
    /Do not modify any file/,
  ]) {
    assert.match(src, rule, `probe rules must include ${rule}`)
  }
})

test('the research synthesis agent is also kept blind to the feature', () => {
  const src = prose('workflows', 'research.js')
  assert.match(src, /You have not been told what anyone intends to build/)
  assert.match(src, /you must not speculate about it/)
})

test('review workers DO receive the approved design — that is how conformance is checked', () => {
  const src = workflowSource('review.js')
  assert.match(src, /04-design\.md|designPath/, 'review must read the approved design')
  assert.match(src, /05-structure\.md|structurePath/, 'review must read the approved structure')
  assert.match(src, /01-intent\.md|intentPath/, 'review may read the intent')
})

// ---------------------------------------------------------------------------
// Failure honesty
// ---------------------------------------------------------------------------

test('workflows filter out failed agents rather than treating them as successes', () => {
  for (const file of WORKFLOWS) {
    const src = workflowSource(file)
    assert.match(src, /\.filter\(Boolean\)/, `${file} must drop null agent results explicitly`)
  }
})

test('research reports unanswered questions instead of inventing findings', () => {
  const src = workflowSource('research.js')
  assert.match(src, /failedQuestions/, 'research must track questions that returned nothing')
  assert.match(src, /must be listed in Scope as unanswered/)
  // A question whose verifier died must not be counted as verified.
  assert.match(src, /an unavailable check is not a passing check/i)
})

test('review reports uncovered dimensions instead of implying full coverage', () => {
  const src = workflowSource('review.js')
  assert.match(src, /failedDimensions/)
  assert.match(src, /must be listed in unverifiedConcerns as not covered/)
})

test('review derives its conclusion from the blocker count rather than trusting the agent', () => {
  const src = workflowSource('review.js')
  assert.match(src, /blockers\.length > 0 \? 'REMEDIATION REQUIRED'/)
})

test('review states that it does not replace human code review', () => {
  const src = workflowSource('review.js')
  assert.match(src, /AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW/)
  assert.match(src, /humanReviewStillRequired: true/)
})

// maxResearchWorkers now limits concurrency, and every question is researched:
// see "finding 17" in workflows-run.test.mjs, which runs the workflow.

// ---------------------------------------------------------------------------
// Plugin structure
// ---------------------------------------------------------------------------

test('the plugin manifest is valid and minimal', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, 'dex')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.length > 40)
  assert.equal(typeof manifest.author, 'object')
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length >= 4)
  // Standard directory discovery is used, so no component paths are declared.
  for (const invented of ['commands', 'stages', 'gates', 'workflowDir']) {
    assert.equal(manifest[invented], undefined, `manifest must not declare unsupported field "${invented}"`)
  }
})

const EXPECTED_SKILLS = [
  'start', 'questions', 'research', 'design', 'structure', 'plan', 'worktree',
  'implement', 'verify', 'review', 'approve', 'status', 'next', 'resume', 'pr', 'doctor',
]

function parseFrontmatter(abs) {
  const raw = fs.readFileSync(abs, 'utf8')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  assert.ok(m, `${abs} must start with YAML frontmatter`)
  const fields = {}
  for (const line of m[1].split('\n')) {
    const km = line.match(/^([A-Za-z-]+):\s*(.*)$/)
    if (km) fields[km[1]] = km[2].trim()
  }
  return { fields, body: m[2] }
}

test('every lifecycle skill exists with the expected frontmatter', () => {
  for (const name of EXPECTED_SKILLS) {
    const abs = path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md')
    assert.ok(fs.existsSync(abs), `skills/${name}/SKILL.md must exist`)
    const { fields, body } = parseFrontmatter(abs)
    assert.equal(fields.name, name, `skills/${name} frontmatter name must match its directory`)
    assert.ok(fields.description && fields.description.length > 30, `skills/${name} needs a real description`)
    assert.ok(body.trim().length > 200, `skills/${name} must have substantive content, not a stub`)
    assert.doesNotMatch(body, /TODO/, `skills/${name} must not contain TODOs`)
  }
})

test('skill names are unique, so no two commands collide', () => {
  const names = EXPECTED_SKILLS.map((n) => parseFrontmatter(path.join(PLUGIN_ROOT, 'skills', n, 'SKILL.md')).fields.name)
  assert.equal(new Set(names).size, names.length)
})

test('stage skills are human-invoked, not model-invoked', () => {
  // A lifecycle stage begins when the engineer decides it does. Only the
  // read-only helpers may be picked up by the model on its own.
  const modelInvocable = new Set(['status', 'next', 'doctor'])
  for (const name of EXPECTED_SKILLS) {
    const { fields } = parseFrontmatter(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'))
    if (modelInvocable.has(name)) {
      assert.notEqual(fields['disable-model-invocation'], 'true', `${name} is a read-only helper and may stay model-invocable`)
    } else {
      assert.equal(fields['disable-model-invocation'], 'true', `${name} must set disable-model-invocation: true`)
    }
  }
})

test('skills that take a feature slug declare an argument hint', () => {
  for (const name of ['start', 'questions', 'research', 'design', 'structure', 'plan', 'worktree', 'implement', 'verify', 'review', 'approve', 'resume', 'pr', 'status', 'next']) {
    const { fields } = parseFrontmatter(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'))
    assert.ok(fields['argument-hint'], `skills/${name} should declare argument-hint`)
  }
})

test('skills call the state script rather than editing state as prose', () => {
  const mustCallState = ['start', 'approve', 'status', 'next', 'plan', 'worktree', 'verify', 'review', 'implement', 'pr', 'resume', 'doctor']
  for (const name of mustCallState) {
    const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8')
    assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/(state|status|doctor)\.mjs/, `skills/${name} must invoke a Dex script`)
  }
})

test('the approve skill forbids hand-editing state', () => {
  assert.match(skillProse('approve'), /Never try to approve another way, for example by editing state files/)
})

test('no skill claims that AI review or plan review replaces reading the code', () => {
  for (const name of EXPECTED_SKILLS) {
    const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8')
    assert.doesNotMatch(body, /no need to review the code/i, name)
    assert.doesNotMatch(body, /removes the need to (?:review|read)/i, name)
    assert.doesNotMatch(body, /passing AI review means the code is approved/i, name)
  }
  assert.match(skillProse('review'), /records no approval/)
  assert.match(skillProse('plan'), /plan review is not code review/)
})

test('the structure skill teaches vertical checkpoints and the correct tracer definition', () => {
  const body = skillProse('structure')
  assert.match(body, /Tracer bullet required: YES \| NO/)
  assert.match(body, /vertical slice.*describes the \*?shape\*?/is)
  assert.match(body, /tracer bullet.*describes the \*?purpose and depth\*?/is)
  assert.match(body, /thinnest end-to-end implementation/i)
  assert.match(body, /Not every slice is a tracer/i)
  assert.match(body, /restructure it vertically/i)
  assert.match(body, /Horizontal dependency exception/)
})

test('the implement skill requires reading current code and stopping on drift', () => {
  const body = skillProse('implement')
  assert.match(body, /Read the current code before editing it/i)
  assert.match(body, /Plans go stale\. Code is ground truth\./)
  assert.match(body, /Repository reality > approved design intent/)
  assert.match(body, /Do not make it work anyway/i)
  assert.match(body, /drift/)
  assert.match(body, /Do not start the next checkpoint unless the user explicitly asks/i)
})

test('the questions skill shows both good and bad question examples', () => {
  const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'questions', 'SKILL.md'), 'utf8')
  const flat = skillProse('questions')
  assert.match(body, /^GOOD\s+Where does/m)
  assert.match(body, /^BAD\s+Where should we add/m)
  assert.match(flat, /research workers will not/i)
})

test('the start skill declines to start Dex for trivial changes', () => {
  const body = skillProse('start')
  assert.match(body, /wrong tool for a typo/i)
  assert.match(body, /Do not start a feature the user did not ask to start/i)
})

const EXPECTED_AGENTS = ['research-probe', 'research-verifier', 'implementation-reviewer', 'verification-analyzer']

test('every agent exists with valid frontmatter', () => {
  for (const name of EXPECTED_AGENTS) {
    const abs = path.join(PLUGIN_ROOT, 'agents', `${name}.md`)
    assert.ok(fs.existsSync(abs), `agents/${name}.md must exist`)
    const { fields, body } = parseFrontmatter(abs)
    assert.equal(fields.name, name)
    assert.ok(fields.description && fields.description.length > 40)
    assert.ok(fields.tools, `agents/${name} must declare its tools`)
    assert.ok(body.trim().length > 300)
    assert.doesNotMatch(body, /TODO/)
  }
})

test('agent names avoid persona theater', () => {
  // Subagents exist for context isolation, not to role-play a corporation.
  for (const name of EXPECTED_AGENTS) {
    assert.doesNotMatch(name, /chief|principal|senior|junior|manager|officer|lead|architect|guru|ninja/i, name)
  }
})

test('research agents have no write tools', () => {
  for (const name of ['research-probe', 'research-verifier']) {
    const { fields, body } = parseFrontmatter(path.join(PLUGIN_ROOT, 'agents', `${name}.md`))
    const tools = fields.tools.split(',').map((t) => t.trim())
    for (const forbidden of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      assert.ok(!tools.includes(forbidden), `agents/${name} must not have ${forbidden}`)
    }
    assert.match(body, /Do not modify any file|no write tools/i)
  }
})

test('agents given Bash are restricted to non-mutating inspection', () => {
  for (const name of ['implementation-reviewer', 'verification-analyzer']) {
    const { fields, body } = parseFrontmatter(path.join(PLUGIN_ROOT, 'agents', `${name}.md`))
    if (!fields.tools.includes('Bash')) continue
    assert.match(body, /read-only/i, `agents/${name} must state that Bash is read-only`)
    assert.match(body, /Do not modify the repository|do not commit/i)
    assert.match(body, /do not install/i)
  }
})

test('the research probe agent refuses to design', () => {
  const body = prose('agents', 'research-probe.md')
  assert.match(body, /You have not been told what feature anyone wants to build/)
  assert.match(body, /FACT/)
  assert.match(body, /INFERENCE/)
  assert.match(body, /UNKNOWN/)
  assert.match(body, /If you did not open the file, it is not a FACT/)
})

test('the verifier agent is told to falsify, not confirm', () => {
  const body = prose('agents', 'research-verifier.md')
  assert.match(body, /try to falsify them, not to confirm them/)
  for (const verdict of ['VERIFIED', 'PARTIALLY VERIFIED', 'UNVERIFIED', 'CONTRADICTED']) {
    assert.ok(body.includes(verdict), `verifier must define ${verdict}`)
  }
})

test('the verification analyzer never suggests deleting a failing test', () => {
  const body = prose('agents', 'verification-analyzer.md')
  assert.match(body, /Never suggest that a failing test be deleted or skipped/)
})

test('the hook configuration registers the PreToolUse guard', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'))
  const entries = hooks.hooks.PreToolUse
  assert.ok(Array.isArray(entries) && entries.length === 1)
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    assert.ok(entries[0].matcher.includes(tool), `matcher must cover ${tool}`)
  }
  const cmd = entries[0].hooks[0]
  assert.equal(cmd.type, 'command')
  assert.match(cmd.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/guard\.mjs/)
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', 'guard.mjs')))
})

test('all nine artifact templates exist and are non-trivial', () => {
  const templates = {
    'intent.md': /## Non-Goals/,
    'questions.md': /Research must not propose the implementation/,
    'research.md': /FACT:/,
    'design.md': /## Least-Confident Decisions/,
    'structure.md': /Tracer bullet required: YES \| NO/,
    'plan.md': /### Stop Conditions/,
    'implementation-log.md': /## DESIGN DRIFT/,
    'review.md': /AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW/,
    'pr.md': /Approved code: `git diff <baseSha> <tree>`/,
  }
  for (const [file, marker] of Object.entries(templates)) {
    const abs = path.join(PLUGIN_ROOT, 'templates', file)
    assert.ok(fs.existsSync(abs), `templates/${file} must exist`)
    const body = fs.readFileSync(abs, 'utf8')
    assert.ok(body.length > 300, `templates/${file} is too thin to be useful`)
    assert.match(body, marker, `templates/${file} is missing its defining section`)
  }
})

test('the plugin depends on no npm packages', () => {
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, 'node_modules')), false)
  const pkg = path.join(PLUGIN_ROOT, 'package.json')
  if (fs.existsSync(pkg)) {
    const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'))
    assert.deepEqual(parsed.dependencies ?? {}, {}, 'Dex must run with no npm install')
    assert.deepEqual(parsed.devDependencies ?? {}, {})
  }
  for (const script of ['lib.mjs', 'state.mjs', 'guard.mjs', 'doctor.mjs', 'status.mjs']) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', script), 'utf8')
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    for (const spec of imports) {
      const ok = spec.startsWith('node:') || spec.startsWith('.')
      assert.ok(ok, `${script} imports "${spec}" — only node: builtins and relative paths are allowed`)
    }
  }
})

test('nothing in the plugin suggests skipping permissions', () => {
  const walk = (dir) => {
    const out = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...walk(abs))
      else if (/\.(md|mjs|js|json)$/.test(e.name)) out.push(abs)
    }
    return out
  }
  for (const abs of walk(PLUGIN_ROOT)) {
    const body = fs.readFileSync(abs, 'utf8')
    const rel = path.relative(PLUGIN_ROOT, abs)
    // The security sections name this flag in order to forbid it; a bare
    // occurrence anywhere else would be a recommendation.
    if (/dangerously-skip-permissions/.test(body)) {
      assert.match(body, /Never|never|not|Do not/, `${rel} mentions the skip-permissions flag without forbidding it`)
    }
    assert.doesNotMatch(body, /--force\s+(?:push|origin)/, `${rel} must not suggest force pushing`)
  }
})

test('the example walks the full lifecycle', () => {
  const abs = path.join(PLUGIN_ROOT, 'examples', 'portfolio-feature.md')
  assert.ok(fs.existsSync(abs), 'examples/portfolio-feature.md must exist')
  const body = fs.readFileSync(abs, 'utf8')
  for (const cmd of [
    '/dex:start', '/dex:questions', '/dex:approve questions', '/dex:research', '/dex:design',
    '/dex:approve design', '/dex:structure', '/dex:approve structure', '/dex:plan',
    '/dex:worktree', '/dex:implement', '/dex:verify', '/dex:review', '/dex:approve code', '/dex:pr',
  ]) {
    assert.ok(body.includes(cmd), `example must show ${cmd}`)
  }
  assert.match(body, /OptimizerService/, 'the example should show the premature-solution names it avoids')
  assert.match(body, /human reads/i)
})

test('the README documents the lifecycle, the gates, and code ownership', () => {
  const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8')
  assert.match(body, /leverage system, not an accountability transfer system/)
  assert.match(body, /claude --plugin-dir \.\/dex/)
  assert.match(body, /claude plugin validate \.\/dex/)
  for (const stage of ['Intent', 'Questions', 'Research', 'Design', 'Structure', 'Plan', 'Worktree', 'Implement', 'Verify', 'Human Code Review', 'PR']) {
    assert.ok(body.includes(stage), `README lifecycle must include ${stage}`)
  }
  for (const cmd of EXPECTED_SKILLS.map((s) => `/dex:${s}`)) {
    assert.ok(body.includes(cmd), `README must document ${cmd}`)
  }
  assert.match(body, /Repository reality/)
  assert.match(body, /tracer bullet/i)
  assert.match(body, /vertical/i)
  assert.match(body, /Node\.js 18/)
})

test('the research workflow re-checks the questions gate itself', () => {
  // The skill checks the gate before invoking the workflow, but the workflow is
  // directly invocable, so the gate has to hold here too.
  const src = workflowSource('research.js')
  assert.match(src, /\$\{stateScript\}" check/, 'the workflow must run the deterministic gate check')
  assert.match(src, /questionsGateStatus !== 'APPROVED'/, 'anything but APPROVED must stop research')
  assert.match(prose('workflows', 'research.js'), /Fail closed: an unreadable gate is treated as an unapproved gate/)
  // The refusal has to name the recovery command, not just decline.
  assert.match(src, /\/dex:approve questions \$\{slug\}/)
})

test('the research workflow declares a phase entry for every phase it starts', () => {
  const meta = workflowMeta('research.js')
  const called = [...workflowSource('research.js').matchAll(/(?:^|\s)phase\('([^']+)'\)/g)].map((m) => m[1])
  assert.deepEqual(called, ['Check gate', 'Parse questions', 'Synthesize'])
  for (const title of called) assert.ok(meta.phases.some((p) => p.title === title), title)
  // Research and Verify are assigned per-agent inside the pipeline rather than by
  // phase(), so they must still be declared.
  for (const title of ['Research', 'Verify']) {
    assert.ok(meta.phases.some((p) => p.title === title), `meta.phases must declare ${title}`)
    assert.match(workflowSource('research.js'), new RegExp(`phase: '${title}'`), `${title} must be assigned per agent`)
  }
})

test('the worktree skill offers to continue or to let the user commit, and never commits itself', () => {
  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'worktree', 'SKILL.md'), 'utf8')
  assert.match(skill, /! cd "\$\(git rev-parse --show-toplevel\)" && git add -- '<new path>' && git commit -m '<message>' -- '<path>' '<path>'/)
  assert.match(skill, /Use single quotes, not double quotes/)
  assert.match(skill, /will not be\s+in the new worktree/)
  assert.match(skill, /path in single quotes, then stop/)
  assert.match(skill, /run\s+`\/dex:worktree <slug>` again/)
  assert.match(skill, /Remove git's quotes and undo its escapes/)
  assert.match(skill, /Continue without them/)
  assert.match(skill, /Never run the commit yourself/)
  assert.match(skill, /Do not stash, reset, check out over the changes,\s+or clean/)
})
