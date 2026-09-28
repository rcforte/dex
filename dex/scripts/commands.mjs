/**
 * dex/scripts/commands.mjs
 *
 * What a shell command does, as far as Dex cares.
 *
 * shell.mjs turns a command line into simple commands. This file looks at each
 * one and answers three questions:
 *   - does it publish work (push, open a PR, upload a package)?
 *   - does it change files, and which ones?
 *   - does it try to record a Dex approval?
 * The guard (guard.mjs) decides what to allow. This file only describes.
 *
 * It errs toward "this changes something". A command it cannot see into, such
 * as an inline script that writes files, counts as a change with unknown paths.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { baseName, parseCommand, SUBST, unwrap } from './shell.mjs'

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/** git's own subcommands. Anything else may be an alias. */
const GIT_BUILTINS = new Set(
  (
    'add am annotate apply archive bisect blame branch bundle cat-file check-ignore check-attr checkout checkout-index ' +
    'cherry cherry-pick citool clean clone commit commit-tree config count-objects credential describe diff diff-files ' +
    'diff-index diff-tree difftool fetch filter-branch for-each-ref format-patch fsck gc grep hash-object help init ' +
    'instaweb log ls-files ls-remote ls-tree maintenance merge merge-base merge-file mergetool mktree mv name-rev notes ' +
    'prune pull push push-to-checkout range-diff read-tree rebase reflog remote repack replace request-pull rerere reset ' +
    'restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-ref sparse-checkout stash ' +
    'status submodule subtree switch symbolic-ref tag update-index update-ref var verify-commit verify-tag version ' +
    'whatchanged worktree write-tree'
  ).split(' ')
)

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])

/** Split `git [global options] <sub> <args>`. */
function gitParts(argv) {
  const config = []
  let k = 1
  while (k < argv.length) {
    const w = argv[k]
    if (w === '-c') {
      config.push(argv[k + 1] ?? '')
      k += 2
    } else if (GIT_VALUE_OPTIONS.has(w)) {
      k += 2
    } else if (/^-[cC]./.test(w)) {
      if (w[1] === 'c') config.push(w.slice(2))
      k++
    } else if (w.startsWith('-')) {
      k++
    } else {
      break
    }
  }
  const aliases = new Map()
  for (const kv of config) {
    const m = /^alias\.([^=]+)=(.*)$/.exec(kv)
    if (m) aliases.set(m[1], m[2])
  }
  return { sub: argv[k], args: argv.slice(k + 1), aliases }
}

/** A git alias from the repository's config, or null. */
export function gitAliasFromConfig(name, cwd) {
  try {
    return execFileSync('git', ['config', '--get', `alias.${name}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

const GIT_PUBLISH = new Set(['push', 'send-pack', 'send-email', 'request-pull'])
const GIT_CHANGE = new Set([
  'commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'apply', 'filter-branch', 'reset', 'restore', 'clean',
  'rm', 'mv', 'pull', 'read-tree', 'checkout-index', 'update-ref', 'update-index',
])

function gitPublish(sub, args) {
  if (GIT_PUBLISH.has(sub)) return `git ${sub}`
  if (sub === 'subtree' && args[0] === 'push') return 'git subtree push'
  return null
}

function gitChange(sub, args) {
  if (GIT_CHANGE.has(sub)) return `git ${sub}`
  // Creating a branch at the current commit changes no files: `git checkout -b x`,
  // `git switch -c x`. With a start point, or forced, it does.
  const operands = args.filter((a) => !a.startsWith('-'))
  if ((sub === 'checkout' && ['-b'].includes(args[0])) || (sub === 'switch' && ['-c', '--create'].includes(args[0]))) {
    return operands.length > 1 ? `git ${sub} (to another commit)` : null
  }
  if (sub === 'checkout' && args.length) return 'git checkout'
  if (sub === 'switch') return 'git switch'
  if (sub === 'stash' && !['list', 'show'].includes(args[0])) return 'git stash'
  if (sub === 'branch' && args.some((a) => /^(?:-[dDmMfcC]|--(?:delete|move|force|copy))$/.test(a))) return 'git branch (delete/move/force)'
  if (sub === 'tag' && args.some((a) => a === '-d' || a === '--delete')) return 'git tag -d'
  if (sub === 'worktree' && ['remove', 'prune', 'move'].includes(args[0])) return `git worktree ${args[0]}`
  if (sub === 'submodule' && ['update', 'add', 'deinit', 'sync'].includes(args[0])) return `git submodule ${args[0]}`
  if (sub === 'sparse-checkout' && ['set', 'add', 'init', 'reapply', 'disable'].includes(args[0])) return 'git sparse-checkout'
  return null
}

// ---------------------------------------------------------------------------
// Hosting tools and network publishing
// ---------------------------------------------------------------------------

/** Remove options that take a value, in both `--opt value` and `--opt=value` forms. */
function withoutOptions(args, names) {
  const out = []
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (names.includes(w)) {
      k++
      continue
    }
    if (names.some((n) => n.startsWith('--') && w.startsWith(`${n}=`))) continue
    out.push(w)
  }
  return out
}

/** The HTTP method a curl / gh api call uses, if one is given. */
function explicitMethod(args, short, long) {
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (w === short || w === long) return String(args[k + 1] ?? '').toUpperCase()
    if (w.startsWith(short) && w.length > short.length && !w.startsWith('--')) return w.slice(short.length).toUpperCase()
    if (w.startsWith(`${long}=`)) return w.slice(long.length + 1).toUpperCase()
  }
  return null
}

const hasAny = (args, flags) => args.some((w) => flags.some((f) => w === f || (f.startsWith('--') && w.startsWith(`${f}=`)) || (!f.startsWith('--') && w.startsWith(f) && w.length > f.length)))

function ghPublish(args) {
  const a = withoutOptions(args, ['-R', '--repo', '--hostname'])
  const [group, action] = a
  if (group === 'pr' && ['create', 'merge', 'ready'].includes(action)) return `gh pr ${action}`
  if (group === 'pr' && action === 'edit' && a.includes('--ready')) return 'gh pr edit --ready'
  if (group === 'release' && ['create', 'upload', 'edit', 'delete'].includes(action)) return `gh release ${action}`
  if (group === 'api') {
    const method = explicitMethod(a, '-X', '--method')
    const fields = hasAny(a, ['-f', '-F', '--field', '--raw-field', '--input'])
    if ((method && method !== 'GET' && method !== 'HEAD') || (!method && fields)) return 'gh api (a write request)'
  }
  return null
}

const HOSTING = /(?:^|[/.@])(?:api\.)?github\.com\b|gitlab/i

function httpPublish(name, args) {
  if (!args.some((a) => HOSTING.test(a))) return null
  if (name === 'curl') {
    const method = explicitMethod(args, '-X', '--request')
    const data = hasAny(args, ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-F', '--form', '-T', '--upload-file'])
    if ((method && method !== 'GET' && method !== 'HEAD') || data) return 'curl (a write request to a code host)'
  }
  if (name === 'wget' && hasAny(args, ['--post-data', '--post-file', '--body-data', '--method'])) return 'wget (a write request to a code host)'
  return null
}

function otherPublish(name, args) {
  switch (name) {
    case 'gh':
      return ghPublish(args)
    case 'glab':
      if (args[0] === 'mr' && ['create', 'merge'].includes(args[1])) return `glab mr ${args[1]}`
      if (args[0] === 'release' && args[1] === 'create') return 'glab release create'
      return null
    case 'hub':
      if (['push', 'pull-request'].includes(args[0])) return `hub ${args[0]}`
      if (args[0] === 'release' && args[1] === 'create') return 'hub release create'
      return null
    case 'curl':
    case 'wget':
      return httpPublish(name, args)
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
    case 'cargo':
    case 'poetry':
    case 'uv':
      return args[0] === 'publish' ? `${name} publish` : null
    case 'docker':
    case 'podman':
      return args[0] === 'push' ? `${name} push` : null
    case 'twine':
      return args[0] === 'upload' ? 'twine upload' : null
    case 'gem':
      return args[0] === 'push' ? 'gem push' : null
    case 'make':
    case 'just':
    case 'task': {
      const target = args.find((a) => !a.startsWith('-') && !a.includes('=') && /push|publish|release|deploy/i.test(a))
      return target ? `${name} ${target}` : null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Inline scripts
// ---------------------------------------------------------------------------

/** Options that introduce inline code, per interpreter. */
const INLINE_CODE = {
  python: ['-c'],
  python3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  bun: ['-e', '--eval'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r'],
}

const INLINE_APPROVE = /state\.mjs['"]?[,\s]+['"]?approve\b/
const INLINE_PUBLISH = /\bgit\b[^;\n]*?\bpush\b|\bgh\b[^;\n]*?\bpr\b[^;\n]*?\b(?:create|merge)\b|\b(?:npm|cargo|twine)\b[^;\n]*?\b(?:publish|upload)\b/
const INLINE_WRITE =
  /writeFile|appendFile|createWriteStream|rmSync|unlinkSync|renameSync|mkdirSync|rmdirSync|copyFile|cpSync|\bopen\([^)]*['"][wax]b?\+?['"]|write_text|write_bytes|os\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir)|shutil\.|os\.system|subprocess|child_process|\bexec(?:Sync)?\(|\bspawn(?:Sync)?\(|File\.(?:write|delete|rename)|FileUtils|file_put_contents|unlink\(|system\(/

function inlineCode(name, args) {
  const flags = INLINE_CODE[name]
  if (!flags) return null
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (flags.includes(w)) return args[k + 1] ?? ''
    const attached = flags.find((f) => f.length === 2 && w.startsWith(f) && w.length > 2)
    if (attached) return w.slice(2)
  }
  return null
}

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

/**
 * Commands that change files, and which operands they change:
 *   all    every operand
 *   rest   every operand after the first (the first is a mode or script)
 *   last   only the destination (the last operand, or -t DIR)
 */
const FILE_OPS = {
  rm: 'all', rmdir: 'all', unlink: 'all', touch: 'all', mkdir: 'all', truncate: 'all', shred: 'all', tee: 'all', mv: 'all',
  chmod: 'rest', chown: 'rest', chgrp: 'rest',
  cp: 'last', install: 'last', rsync: 'last', ln: 'last',
}

/** Options that take a separate value, so the value is not mistaken for a file. */
const FILE_OP_VALUES = {
  truncate: ['-s', '--size', '-r', '--reference'],
  install: ['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory', '-S', '--suffix'],
  cp: ['-t', '--target-directory', '-S', '--suffix'],
  mv: ['-t', '--target-directory', '-S', '--suffix'],
  ln: ['-t', '--target-directory', '-S', '--suffix'],
  rsync: ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--exclude-from', '--include-from'],
  chmod: ['--reference'],
  chown: ['--reference', '--from'],
}

function fileOperands(name, args) {
  const values = FILE_OP_VALUES[name] ?? []
  const operands = []
  let targetDir = null
  let endOfOptions = false
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (!endOfOptions && w === '--') {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && w.startsWith('-') && w.length > 1) {
      if (['-t', '--target-directory'].includes(w)) targetDir = args[k + 1]
      else if (w.startsWith('--target-directory=')) targetDir = w.slice('--target-directory='.length)
      if (values.includes(w)) k++
      continue
    }
    operands.push(w)
  }
  const mode = FILE_OPS[name]
  if (mode === 'rest') return operands.slice(1)
  if (mode === 'last') return targetDir ? [targetDir] : operands.slice(-1)
  return operands
}

/** `sed -i` edits the files it is given; the first operand is the script unless -e/-f supplied one. */
function sedInPlace(args) {
  const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))
  if (!inPlace) return null
  const scriptGiven = args.some((a) => ['-e', '-f', '--expression', '--file'].includes(a) || a.startsWith('--expression=') || a.startsWith('--file='))
  const operands = []
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (['-e', '-f', '--expression', '--file', '-l', '--line-length'].includes(w)) {
      k++
      continue
    }
    if (w.startsWith('-')) continue
    operands.push(w)
  }
  return scriptGiven ? operands : operands.slice(1)
}

/** Formatters and fixers rewrite files in place. `check` modes only read. */
function formatterChange(name, args, text) {
  const has = (...flags) => args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)))
  switch (name) {
    case 'prettier':
      return has('--write', '-w') ? 'prettier --write' : null
    case 'eslint':
    case 'stylelint':
      return has('--fix') ? `${name} --fix` : null
    case 'gofmt':
    case 'goimports':
      return args.some((a) => /^-[a-z]*w/.test(a)) ? `${name} -w` : null
    case 'rustfmt':
      return has('--check') ? null : 'rustfmt'
    case 'cargo':
      if (args[0] === 'fmt') return has('--check') ? null : 'cargo fmt'
      if (args[0] === 'clippy' && has('--fix')) return 'cargo clippy --fix'
      if (args[0] === 'fix') return 'cargo fix'
      return null
    case 'black':
    case 'isort':
      return has('--check', '--diff', '--check-only') ? null : name
    case 'ruff':
      if (args[0] === 'format') return has('--check', '--diff') ? null : 'ruff format'
      return has('--fix') ? 'ruff --fix' : null
    case 'clang-format':
      return has('-i') ? 'clang-format -i' : null
    case 'go':
      return args[0] === 'generate' ? 'go generate' : null
    case 'terraform':
      return args[0] === 'fmt' && !has('-check') ? 'terraform fmt' : null
    case 'dotnet':
      return args[0] === 'format' && !has('--verify-no-changes') ? 'dotnet format' : null
    case 'biome':
      return has('--write', '--apply', '--fix') ? `biome ${args[0] ?? ''} --write`.trim() : null
    case 'rubocop':
      return has('-a', '-A', '--autocorrect', '--autocorrect-all') ? 'rubocop --autocorrect' : null
    case 'swiftformat':
      return has('--lint') ? null : 'swiftformat'
    case 'ktlint':
      return has('-F', '--format') ? 'ktlint --format' : null
    case 'php-cs-fixer':
      return args[0] === 'fix' && !has('--dry-run') ? 'php-cs-fixer fix' : null
    default:
      return /\bspotless(?::apply|Apply)\b/.test(text) ? 'spotless apply' : null
  }
}

/** Dependency and migration commands, matched on the unwrapped command text. */
const TEXT_CHANGES = [
  { re: /^(?:npm|pnpm)\s+(?:install|i|ci|add|update|up|uninstall|remove|rm|un|link)\b/, what: 'an npm/pnpm dependency change' },
  { re: /^yarn(?:\s*$|\s+(?:add|install|remove|up|upgrade)\b)/, what: 'a yarn dependency change' },
  { re: /^bun\s+(?:add|install|remove|update)\b/, what: 'a bun dependency change' },
  { re: /^(?:pip|pip3)\s+(?:install|uninstall)\b/, what: 'a pip dependency change' },
  { re: /^python3?\s+-m\s+pip\s+(?:install|uninstall)\b/, what: 'a pip dependency change' },
  { re: /^(?:poetry|uv)\s+(?:add|remove|install|sync|lock)\b/, what: 'a Python dependency change' },
  { re: /^uv\s+pip\s+(?:install|uninstall|sync)\b/, what: 'a Python dependency change' },
  { re: /^cargo\s+(?:add|remove|install|update)\b/, what: 'a cargo dependency change' },
  { re: /^go\s+(?:get|install)\b/, what: 'a go dependency change' },
  { re: /^go\s+mod\s+(?:tidy|edit|vendor)\b/, what: 'a go module change' },
  { re: /^(?:gem|bundle)\s+(?:install|add|update)\b/, what: 'a Ruby dependency change' },
  { re: /^composer\s+(?:require|install|update|remove)\b/, what: 'a composer dependency change' },
  { re: /^(?:apt|apt-get|yum|dnf|apk|brew|choco|winget|pacman)\s+(?:install|add|remove|upgrade|-S)\b/, what: 'a system package installation' },
  { re: /^flyway\s+(?:migrate|clean|undo|repair)\b/, what: 'a Flyway migration' },
  { re: /^liquibase\s+(?:update|rollback|dropAll)\b/, what: 'a Liquibase migration' },
  { re: /^alembic\s+(?:upgrade|downgrade|stamp)\b/, what: 'an Alembic migration' },
  { re: /^prisma\s+(?:migrate|db\s+push)\b/, what: 'a Prisma migration' },
  { re: /^(?:knex|sequelize|sequelize-cli|dbmate|goose|atlas|sqlx)\b.*\b(?:migrate|db:migrate|up|apply|run)\b/, what: 'a database migration' },
  { re: /\bmanage\.py\s+migrate\b/, what: 'a Django migration' },
  { re: /^(?:bin\/)?rails\s+db:(?:migrate|rollback|drop|reset)\b/, what: 'a Rails migration' },
  { re: /^(?:mysql|psql|sqlite3|mongosh)\b.*\b(?:DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i, what: 'a destructive database statement' },
  { re: /^(?:find)\b.*\s-delete\b/, what: 'find -delete' },
  { re: /^(?:find)\b.*\s-exec(?:dir)?\s+(?:rm|mv|sed|truncate|perl|chmod)\b/, what: 'find -exec with a changing command' },
  { re: /^(?:perl|ruby)\b.*\s-[a-zA-Z]*i/, what: 'an in-place interpreter edit' },
  { re: /^g?awk\b.*(?:-i\s+inplace|--inplace)\b/, what: 'awk in-place edit' },
  { re: /^(?:patch|ed|ex|dd)(?:\s|$)/, what: 'a file-editing command' },
  { re: /^(?:set-content|add-content|out-file|remove-item|move-item|copy-item|new-item|rename-item|clear-content)\b/i, what: 'a PowerShell file command' },
]

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

/**
 * Describe every simple command in a command line.
 *
 * Returns [{ argv, cwd, writes, publish, change, approve }]:
 *   argv     the program actually run, wrappers removed
 *   cwd      the directory it runs in (`cd` earlier in the line is followed)
 *   writes   redirect targets, as written
 *   publish  a short description when it publishes work, else null
 *   change   { what, paths } when it changes files; paths are the operands it
 *            changes, or null when they cannot be known
 *   approve  true when it runs `state.mjs approve`
 */
export function describeCommand(command, { cwd = process.cwd(), lookupAlias = gitAliasFromConfig } = {}) {
  const { commands } = parseCommand(command)
  const aliases = new Map()
  const out = []
  let dir = cwd
  for (const c of commands) {
    const argv = unwrap(c.argv) ?? []
    const entry = { argv, cwd: dir, writes: c.redirects.map((r) => r.target), publish: null, change: null, approve: false }
    out.push(entry)
    if (!argv.length) continue
    const name = baseName(argv[0]).toLowerCase()
    const args = argv.slice(1)

    if (name === 'cd' || name === 'pushd') {
      const target = args.find((a) => !a.startsWith('-'))
      if (target && !target.includes(SUBST) && !target.includes('$')) dir = path.resolve(dir, target.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
      continue
    }

    entry.approve = argv.some((w, k) => baseName(w) === 'state.mjs' && argv[k + 1] === 'approve')

    if (name === 'git') {
      let { sub, args: gitArgs, aliases: inline } = gitParts(argv)
      if (sub === 'config') {
        const key = gitArgs.find((a) => a.startsWith('alias.'))
        if (key) aliases.set(key.slice('alias.'.length), gitArgs[gitArgs.indexOf(key) + 1] ?? '')
      }
      for (let n = 0; n < 5 && sub && !GIT_BUILTINS.has(sub); n++) {
        const value = inline.get(sub) ?? aliases.get(sub) ?? lookupAlias(sub, dir)
        if (!value) break
        if (value.startsWith('!')) {
          // A shell alias: describe what it runs.
          for (const inner of describeCommand(value.slice(1), { cwd: dir, lookupAlias })) {
            entry.publish ??= inner.publish
            entry.change ??= inner.change
          }
          sub = null
          break
        }
        const words = parseCommand(value).commands[0]?.argv ?? []
        sub = words[0]
        gitArgs = [...words.slice(1), ...gitArgs]
      }
      if (sub) {
        entry.publish ??= gitPublish(sub, gitArgs)
        const what = gitChange(sub, gitArgs)
        if (what) entry.change ??= { what, paths: null }
      }
      continue
    }

    entry.publish = otherPublish(name, args)

    const code = inlineCode(name, args)
    if (code !== null) {
      if (INLINE_APPROVE.test(code)) entry.approve = true
      if (INLINE_PUBLISH.test(code)) entry.publish ??= 'a publish command inside an inline script'
      if (INLINE_WRITE.test(code)) {
        entry.change = { what: 'an inline script that can write files', paths: null }
        continue
      }
    }

    if (FILE_OPS[name]) {
      entry.change = { what: name, paths: fileOperands(name, args) }
      continue
    }
    if (name === 'dd') {
      const of = args.find((a) => a.startsWith('of='))
      if (of) entry.change = { what: 'dd', paths: [of.slice(3)] }
      continue
    }
    if (name === 'sed') {
      const paths = sedInPlace(args)
      if (paths) entry.change = { what: 'sed -i (in-place edit)', paths }
      continue
    }
    const text = [name, ...args].join(' ')
    const formatter = formatterChange(name, args, text)
    if (formatter) {
      entry.change = { what: formatter, paths: null }
      continue
    }
    const hit = TEXT_CHANGES.find((p) => p.re.test(text))
    if (hit) entry.change = { what: hit.what, paths: null }
  }
  return out
}
