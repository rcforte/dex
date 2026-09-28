/**
 * Guard tests: the PreToolUse policy, exercised as a pure function against
 * synthetic hook payloads, plus end-to-end through the hook entry point.
 *
 * Two properties matter equally here:
 *   - a real mutation before the gates pass is refused
 *   - ordinary read-only work is never refused (a guard that blocks `git status`
 *     gets switched off, and then it protects nothing)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { decide, splitSegments, unsafeRedirectTargets, writeTargets } from '../scripts/guard.mjs'
import { computeGates } from '../scripts/state.mjs'
import { DEFAULT_CONFIG, loadConfig, loadFeatureState } from '../scripts/lib.mjs'
import { advanceTo, cleanupRepos, completeImplementation, makeRepo, state, PLUGIN_ROOT } from './helpers.mjs'

test.after(cleanupRepos)

const CONFIG = { ...DEFAULT_CONFIG }

/** Build a decide() context from a real repository at a real lifecycle stage. */
async function ctxAt(stage, { slug = 'feat' } = {}) {
  const root = makeRepo()
  const extra = await advanceTo(root, slug, stage)
  const config = loadConfig(root)
  const s = loadFeatureState(root, config, slug)
  return {
    root,
    config,
    worktree: extra.worktree || null,
    feature: { slug, state: s, gates: computeGates(root, config, s) },
    refresh() {
      const st = loadFeatureState(root, config, slug)
      this.feature = { slug, state: st, gates: computeGates(root, config, st) }
      return this
    },
  }
}

const bash = (command) => ({ toolName: 'Bash', toolInput: { command } })
const write = (file_path) => ({ toolName: 'Write', toolInput: { file_path } })
const edit = (file_path) => ({ toolName: 'Edit', toolInput: { file_path } })

function verdict(ctx, call) {
  return decide({ ...call, root: ctx.root, config: ctx.config, feature: ctx.feature })
}

// ---------------------------------------------------------------------------
// Production code writes before implementation is unlocked
// ---------------------------------------------------------------------------

test('Write to production code during design is DENIED', async () => {
  const ctx = await ctxAt('design')
  const r = verdict(ctx, write(path.join(ctx.root, 'src/PortfolioService.java')))
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /blocked production code modification \(Write\)/)
  assert.match(r.reason, /src\/PortfolioService\.java/)
  assert.match(r.reason, /Required before implementation:/)
  assert.match(r.reason, /docs\/dex\/\*\* and \.dex\/\*\* are allowed right now/)
})

test('Edit to production code during design is DENIED', async () => {
  const ctx = await ctxAt('design')
  assert.equal(verdict(ctx, edit('src/PortfolioService.java')).decision, 'deny')
})

test('NotebookEdit to a notebook during design is DENIED', async () => {
  const ctx = await ctxAt('design')
  const r = decide({
    toolName: 'NotebookEdit',
    toolInput: { notebook_path: 'analysis/model.ipynb' },
    root: ctx.root, config: ctx.config, feature: ctx.feature,
  })
  assert.equal(r.decision, 'deny')
})

test('MultiEdit is evaluated across every edit target', async () => {
  const ctx = await ctxAt('design')
  const r = decide({
    toolName: 'MultiEdit',
    toolInput: { edits: [{ file_path: 'docs/dex/feat/04-design.md' }, { file_path: 'src/PortfolioService.java' }] },
    root: ctx.root, config: ctx.config, feature: ctx.feature,
  })
  assert.equal(r.decision, 'deny', 'one production target among artifact targets must still be refused')
  assert.match(r.reason, /src\/PortfolioService\.java/)
  assert.doesNotMatch(r.reason, /04-design\.md/)
})

test('Write to a Dex artifact during design is ALLOWED', async () => {
  const ctx = await ctxAt('design')
  for (const p of [
    'docs/dex/feat/04-design.md',
    path.join(ctx.root, 'docs/dex/feat/05-structure.md'),
    'docs/dex/other-feature/01-intent.md',
  ]) {
    assert.equal(verdict(ctx, write(p)).decision, 'allow', p)
  }
})

test('finding 2: Write to Dex state during design is DENIED', async () => {
  const ctx = await ctxAt('design')
  for (const p of ['.dex/feat/state.json', '.dex/active', '.dex/config.json']) {
    assert.equal(verdict(ctx, write(p)).decision, 'deny', p)
  }
})

test('Windows-style paths are normalized before the gate check', async () => {
  // Real state and real gates from a real repository; only the root is a Windows
  // path, so this exercises path normalization and nothing else.
  const real = await ctxAt('design')
  const args = { root: 'C:\\repo', config: real.config, feature: real.feature }

  assert.equal(decide({ ...write('C:\\repo\\src\\foo.java'), ...args }).decision, 'deny')
  assert.equal(decide({ ...write('C:\\repo\\src\\deep\\nested\\Bar.cs'), ...args }).decision, 'deny')
  assert.equal(decide({ ...write('C:\\repo\\docs\\dex\\feat\\04-design.md'), ...args }).decision, 'allow')
  assert.equal(decide({ ...write('C:\\repo\\.dex\\feat\\state.json'), ...args }).decision, 'deny')
  // Drive-letter case must not defeat the relative-path check.
  assert.equal(decide({ ...write('c:\\repo\\docs\\dex\\feat\\02-questions.md'), ...args }).decision, 'allow')
})

test('paths inside the feature worktree are relativized against the worktree', async () => {
  const ctx = await ctxAt('worktree')
  // Force implementation closed so the path rule is what is under test.
  ctx.feature.gates.canImplement = { allowed: false, blockers: ['test-forced'] }
  assert.equal(verdict(ctx, write(path.join(ctx.worktree, 'src/Foo.java'))).decision, 'deny')
  assert.equal(verdict(ctx, write(path.join(ctx.worktree, 'docs/dex/feat/07-implementation-log.md'))).decision, 'allow')
})

// ---------------------------------------------------------------------------
// Read-only shell work is never refused
// ---------------------------------------------------------------------------

test('read-only inspection during design is ALLOWED', async () => {
  const ctx = await ctxAt('design')
  const allowed = [
    'git status', 'git status --porcelain', 'git diff', 'git diff --stat HEAD',
    'git diff --name-status main', 'git log --oneline -20', 'git show HEAD',
    'git blame src/PortfolioService.java', 'git rev-parse HEAD', 'git merge-base main HEAD',
    'git rev-list --count main..HEAD', 'git branch', 'git branch -a', 'git tag',
    'git worktree list', 'git stash list', 'git config --get user.name',
    'git for-each-ref', 'git shortlog -sn', 'git fetch origin', 'git diff-tree -r HEAD',
    'ls -la src', 'cat src/PortfolioService.java', 'head -50 pom.xml', 'tail -20 build.log',
    'wc -l src/*.java', 'find . -name "*.java"', 'grep -rn "rm -rf" src',
    'rg "TODO" --type java', 'which mvn', 'pwd', 'echo hello',
    'mvn test', 'mvn -q clean test', './gradlew test', 'npm test', 'npm run lint',
    'npm run build', 'pytest -q', 'go test ./...', 'cargo test', 'cargo clippy',
    'make test', 'dotnet test', 'mkdir -p /tmp/scratch',
    'mvn -q test > /dev/null 2>&1', 'npm test 2>&1 | tail -20', 'git diff > /tmp/review.patch',
    'cat src/PortfolioService.java | grep class', 'git log | head -5',
  ]
  for (const cmd of allowed) {
    const r = verdict(ctx, bash(cmd))
    assert.equal(r.decision, 'allow', `must allow: ${cmd}\n  reason: ${r.reason || ''}`)
  }
})

test('worktree creation is ALLOWED — it is a prerequisite stage, not implementation', async () => {
  const ctx = await ctxAt('plan')
  for (const cmd of [
    'git worktree add ../repo-dex-feat -b dex/feat',
    'git branch dex/feat',
    'git switch -c dex/feat',
    'git checkout -b dex/feat',
  ]) {
    assert.equal(verdict(ctx, bash(cmd)).decision, 'allow', cmd)
  }
})

// ---------------------------------------------------------------------------
// Shell mutations before implementation
// ---------------------------------------------------------------------------

test('repository mutations during design are DENIED', async () => {
  const ctx = await ctxAt('design')
  const denied = [
    'git commit -am "wip"', 'git commit --amend', 'git merge main', 'git rebase main',
    'git cherry-pick abc123', 'git revert HEAD', 'git reset --hard HEAD~1', 'git reset',
    'git restore src/PortfolioService.java', 'git checkout -- src/PortfolioService.java',
    'git clean -fd', 'git stash', 'git stash push -m wip', 'git rm src/Old.java',
    'git mv a b', 'git branch -D old-branch', 'git tag -d v1', 'git apply patch.diff',
    'git worktree remove ../old', 'git update-ref refs/heads/main HEAD',
    'rm src/Old.java', 'rm -rf src', 'rmdir src', 'mv src/A.java src/B.java',
    'cp /tmp/x.java src/x.java', 'truncate -s 0 src/A.java', 'ln -s a b',
    'sed -i "s/a/b/" src/A.java', 'sed -i.bak "s/a/b/" src/A.java',
    'perl -pi -e "s/a/b/" src/A.java', 'patch -p1 < fix.diff',
    'find . -name "*.tmp" -delete', 'find . -name "*.java" -exec sed -i "s/a/b/" {} +',
    'npm install lodash', 'npm ci', 'npm uninstall lodash', 'pnpm add zod',
    'yarn add react', 'bun add hono', 'pip install requests', 'pip3 uninstall requests',
    'poetry add httpx', 'cargo add serde', 'go get example.com/x', 'go mod tidy',
    'gem install rails', 'composer require guzzle', 'apt-get install -y jq',
    'brew install jq',
    'flyway migrate', 'liquibase update', 'alembic upgrade head',
    'npx prisma migrate dev', 'python manage.py migrate', 'rails db:migrate',
    'npx knex migrate:latest',
    'echo "class New {}" > src/New.java', 'cat template >> src/New.java',
    'cat x | tee src/y.java',
    'git status && rm -rf src',
    'cd /tmp; git commit -am x',
  ]
  for (const cmd of denied) {
    const r = verdict(ctx, bash(cmd))
    assert.equal(r.decision, 'deny', `must deny: ${cmd}`)
    assert.match(r.reason, /implementation has not been unlocked|blocked a shell redirect|blocked git push/, cmd)
  }
})

test('a denial explains the phase, the blockers, and the recovery command', async () => {
  const ctx = await ctxAt('design')
  const r = verdict(ctx, bash('rm -rf src'))
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /Current phase: design/)
  assert.match(r.reason, /Required before implementation:/)
  assert.match(r.reason, /- structure is/)
  assert.match(r.reason, /Read-only inspection .* is allowed/)
  assert.match(r.reason, /Next:\n {2}\/dex:approve design feat/)
})

test('redirect targets are classified by destination, not by command', async () => {
  const ctx = await ctxAt('design')
  const ok = { root: ctx.root, artifactRoot: 'docs/dex', stateRoot: '.dex' }
  assert.deepEqual(unsafeRedirectTargets('mvn test > /dev/null 2>&1', ok), [])
  assert.deepEqual(unsafeRedirectTargets('mvn test > /tmp/out.log', ok), [])
  assert.deepEqual(unsafeRedirectTargets('echo x > docs/dex/feat/04-design.md', ok), [])
  assert.deepEqual(unsafeRedirectTargets('echo x > .dex/feat/notes.json', ok), [])
  assert.deepEqual(unsafeRedirectTargets('echo x > src/New.java', ok), ['src/New.java'])
  assert.deepEqual(unsafeRedirectTargets('echo x >> pom.xml', ok), ['pom.xml'])
})

// ---------------------------------------------------------------------------
// After implementation is unlocked
// ---------------------------------------------------------------------------

test('source edits during implementation are ALLOWED', async () => {
  const ctx = await ctxAt('worktree')
  assert.equal(ctx.feature.gates.canImplement.allowed, true)
  for (const call of [
    write(path.join(ctx.worktree, 'src/Optimizer.java')),
    edit('src/PortfolioService.java'),
    bash('git commit -am "S1 tracer"'),
    bash('rm src/Obsolete.java'),
    bash('sed -i "s/a/b/" src/PortfolioService.java'),
    bash('npm install lodash'),
    bash('echo "class New {}" > src/New.java'),
  ]) {
    const r = verdict(ctx, call)
    assert.equal(r.decision, 'allow', JSON.stringify(call))
  }
})

test('a stale design approval re-locks production code edits', async () => {
  const ctx = await ctxAt('worktree')
  assert.equal(verdict(ctx, edit('src/PortfolioService.java')).decision, 'allow')

  fs.writeFileSync(path.join(ctx.root, 'docs/dex/feat/04-design.md'), '# Design\n\nsilently changed\n')
  ctx.refresh()

  const r = verdict(ctx, edit('src/PortfolioService.java'))
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /design is STALE/)
})

test('recorded design drift re-locks production code edits', async () => {
  const ctx = await ctxAt('worktree')
  await state(ctx.root, ['drift', 'feat', '--reason', 'events are emitted elsewhere', '--slice', 'S1'])
  ctx.refresh()

  const r = verdict(ctx, edit('src/PortfolioService.java'))
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /feature is blocked: events are emitted elsewhere/)
})

// ---------------------------------------------------------------------------
// The publish gate
// ---------------------------------------------------------------------------

test('push and PR creation are DENIED before human code approval', async () => {
  const ctx = await ctxAt('worktree')
  await completeImplementation(ctx.root, 'feat', ctx.worktree)
  ctx.refresh()

  assert.equal(ctx.feature.gates.verification.status, 'PASS')
  assert.equal(ctx.feature.gates.aiReview.status, 'PASS')
  assert.equal(ctx.feature.gates.humanCodeReview.approved, false)

  for (const cmd of [
    'git push', 'git push origin dex/feat', 'git push -u origin HEAD',
    'git -C /tmp/wt push origin HEAD', 'gh pr create --fill',
    'gh pr create --base main --head dex/feat --title x --body y',
    'gh pr merge 12 --squash', 'gh release create v1',
    'glab mr create', 'hub pull-request', 'git request-pull main origin',
    'git send-email --to x HEAD~1', 'git commit -am x && git push',
  ]) {
    const r = verdict(ctx, bash(cmd))
    assert.equal(r.decision, 'deny', `must deny: ${cmd}`)
    assert.match(r.reason, /human code review is REQUIRED/)
    assert.match(r.reason, /A human has to read the production diff/)
    assert.match(r.reason, /AI review and passing tests do not substitute/)
    assert.match(r.reason, /\/dex:approve code feat/)
  }
})

test('push is ALLOWED once every PR gate is satisfied and the approved code is committed', async () => {
  const ctx = await ctxAt('worktree')
  await completeImplementation(ctx.root, 'feat', ctx.worktree)
  await state(ctx.root, ['approve', 'feat', 'code'])
  execFileSync('git', ['add', '-A'], { cwd: ctx.worktree })
  execFileSync('git', ['commit', '-qm', 'feature'], { cwd: ctx.worktree })
  ctx.refresh()

  assert.equal(ctx.feature.gates.canPr.allowed, true)
  assert.equal(verdict(ctx, bash('git push -u origin dex/feat')).decision, 'allow')
  assert.equal(verdict(ctx, bash('gh pr create --fill')).decision, 'allow')
})

test('push is DENIED again once the approved diff changes', async () => {
  const ctx = await ctxAt('worktree')
  await completeImplementation(ctx.root, 'feat', ctx.worktree)
  await state(ctx.root, ['approve', 'feat', 'code'])
  fs.appendFileSync(path.join(ctx.worktree, 'src', 'Optimizer.java'), '// after approval\n')
  ctx.refresh()

  const r = verdict(ctx, bash('git push origin dex/feat'))
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /human code review is STALE/)
})

test('a passing AI review alone does not open the publish gate', async () => {
  const ctx = await ctxAt('worktree')
  await completeImplementation(ctx.root, 'feat', ctx.worktree)
  ctx.refresh()
  const r = verdict(ctx, bash('git push'))
  assert.equal(r.decision, 'deny', 'AI review must never substitute for human approval')
})

// ---------------------------------------------------------------------------
// Feature resolution
// ---------------------------------------------------------------------------

test('with no active Dex feature, nothing is gated', () => {
  const args = { root: '/some/repo', config: CONFIG, feature: null }
  for (const call of [write('src/foo.java'), edit('src/foo.java'), bash('rm -rf src'), bash('git commit -am x')]) {
    assert.equal(decide({ ...call, ...args }).decision, 'allow', 'Dex must not hijack ordinary work')
  }
})

test('finding 19: with several active features and none marked, changes and publishing are refused', () => {
  const args = { root: '/some/repo', config: CONFIG, feature: null, ambiguous: true, candidates: ['feat-a', 'feat-b'] }
  assert.equal(decide({ ...write('src/foo.java'), ...args }).decision, 'deny')
  assert.equal(decide({ ...bash('rm -rf src'), ...args }).decision, 'deny')
  assert.equal(decide({ ...bash('git status'), ...args }).decision, 'allow')
  assert.equal(decide({ ...write('docs/dex/feat-a/04-design.md'), ...args }).decision, 'allow')

  const r = decide({ ...bash('git push origin HEAD'), ...args })
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /several features are active and none is marked current/)
  assert.match(r.reason, /feat-a/)
  assert.match(r.reason, /feat-b/)
  assert.match(r.reason, /will not guess which feature's gates apply/)
})

test('tools Dex does not gate are always allowed', () => {
  const feature = {
    slug: 'feat',
    state: { phase: 'design', artifacts: {}, worktree: {} },
    gates: { canImplement: { allowed: false, blockers: [] }, canPr: { allowed: false, blockers: [] }, humanCodeReview: { approved: false } },
  }
  for (const toolName of ['Read', 'Grep', 'Glob', 'Task', 'WebFetch', 'TodoWrite']) {
    const r = decide({ toolName, toolInput: { file_path: 'src/foo.java' }, root: '/r', config: CONFIG, feature })
    assert.equal(r.decision, 'allow', toolName)
  }
})

// ---------------------------------------------------------------------------
// Parsing units
// ---------------------------------------------------------------------------

test('command segmentation anchors patterns at each segment start', () => {
  assert.deepEqual(splitSegments('git status && rm -rf src'), ['git status', 'rm -rf src'])
  assert.deepEqual(splitSegments('cat a | grep b | wc -l'), ['cat a', 'grep b', 'wc -l'])
  assert.deepEqual(splitSegments('a; b\nc'), ['a', 'b', 'c'])
  // Leading environment assignments and transparent wrappers are stripped so the
  // real command is what gets matched.
  assert.deepEqual(splitSegments('FOO=bar sudo rm -rf /'), ['rm -rf /'])
  assert.deepEqual(splitSegments('CI=true NODE_ENV=test npm test'), ['npm test'])
  assert.deepEqual(splitSegments('time mvn test'), ['mvn test'])
  // A mutation hidden in command substitution still becomes its own segment.
  assert.ok(splitSegments('echo $(rm -rf src)').includes('rm -rf src'))
})

test('write targets are collected from every tool input shape', () => {
  assert.deepEqual(writeTargets('Write', { file_path: 'a.java' }), ['a.java'])
  assert.deepEqual(writeTargets('NotebookEdit', { notebook_path: 'n.ipynb' }), ['n.ipynb'])
  assert.deepEqual(writeTargets('MultiEdit', { edits: [{ file_path: 'a' }, { file_path: 'b' }] }), ['a', 'b'])
  assert.deepEqual(writeTargets('Write', {}), [])
})

// ---------------------------------------------------------------------------
// End to end through the hook entry point
// ---------------------------------------------------------------------------

/** Run guard.mjs exactly as Claude Code would: JSON on stdin, JSON or nothing out. */
function runHook(payload, cwd) {
  const out = execFileSync('node', [path.join(PLUGIN_ROOT, 'scripts', 'guard.mjs')], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  if (!out.trim()) return { decision: 'allow' }
  const parsed = JSON.parse(out)
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason,
    event: parsed.hookSpecificOutput.hookEventName,
  }
}

test('the hook entry point emits a PreToolUse deny decision', async () => {
  const ctx = await ctxAt('design')
  const denied = runHook(
    { hook_event_name: 'PreToolUse', cwd: ctx.root, tool_name: 'Write', tool_input: { file_path: path.join(ctx.root, 'src/Foo.java') } },
    ctx.root
  )
  assert.equal(denied.decision, 'deny')
  assert.equal(denied.event, 'PreToolUse')
  assert.match(denied.reason, /blocked production code modification/)

  const allowed = runHook(
    { hook_event_name: 'PreToolUse', cwd: ctx.root, tool_name: 'Write', tool_input: { file_path: path.join(ctx.root, 'docs/dex/feat/04-design.md') } },
    ctx.root
  )
  assert.equal(allowed.decision, 'allow')
})

test('the hook resolves the feature from .dex/active when several are open', async () => {
  const root = makeRepo()
  await advanceTo(root, 'feat-a', 'design')
  await advanceTo(root, 'feat-b', 'worktree')

  // advanceTo marked feat-b active last, and feat-b has implementation unlocked.
  assert.equal(fs.readFileSync(path.join(root, '.dex/active'), 'utf8').trim(), 'feat-b')
  assert.equal(
    runHook({ cwd: root, tool_name: 'Edit', tool_input: { file_path: 'src/PortfolioService.java' } }, root).decision,
    'allow'
  )

  // Point the marker at the feature that is still in design.
  await state(root, ['active', 'feat-a'])
  const r = runHook({ cwd: root, tool_name: 'Edit', tool_input: { file_path: 'src/PortfolioService.java' } }, root)
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /feature "feat-a"/)
})

test('unparseable or empty hook input allows rather than blocking everything', () => {
  const root = makeRepo()
  const bad = execFileSync('node', [path.join(PLUGIN_ROOT, 'scripts', 'guard.mjs')], {
    cwd: root, input: 'not json at all', encoding: 'utf8',
  })
  assert.equal(bad.trim(), '')
  const empty = execFileSync('node', [path.join(PLUGIN_ROOT, 'scripts', 'guard.mjs')], {
    cwd: root, input: '', encoding: 'utf8',
  })
  assert.equal(empty.trim(), '')
})

test('the hook exits zero even when it denies, so Claude Code reads the decision', async () => {
  const ctx = await ctxAt('design')
  const res = execFileSync(
    'node',
    [path.join(PLUGIN_ROOT, 'scripts', 'guard.mjs')],
    { cwd: ctx.root, input: JSON.stringify({ cwd: ctx.root, tool_name: 'Write', tool_input: { file_path: 'src/Foo.java' } }), encoding: 'utf8' }
  )
  assert.match(res, /permissionDecision/)
})
