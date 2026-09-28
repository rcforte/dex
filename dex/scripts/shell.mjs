/**
 * dex/scripts/shell.mjs
 *
 * A small POSIX-shell reader for the guard.
 *
 * Why this exists: the guard has to know what a command line runs and where it
 * writes. Pattern-matching the raw text gets both wrong: `echo 'a > b'` looks
 * like a redirect, `git pu""sh` does not look like a push, and a heredoc body
 * full of `rm` lines looks like a script. This reads the text the way a shell
 * would, closely enough for those questions, and nothing more. It never runs
 * anything and never expands variables.
 *
 * parseCommand(text) returns { commands: [{ argv, redirects }] }, where
 *   argv       the words of one simple command, quotes and escapes removed
 *   redirects  [{ op, target }] for every output redirect in that command
 * Commands inside $(...), backticks, `sh -c '...'` and `eval ...` are parsed
 * too and appended to the list.
 */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox-sh'])

/** A command substitution's text is replaced by this marker inside a word. */
export const SUBST = '\u0000subst\u0000'

export function parseCommand(text, depth = 0) {
  const commands = []
  if (depth > 6) return { commands }
  const src = String(text ?? '')
  let i = 0

  let words = []
  let redirects = []
  let word = ''
  let inWord = false
  let pendingRedirect = null // { op } waiting for its target word
  const heredocs = [] // delimiters waiting for the next newline

  const endWord = () => {
    if (!inWord) return
    if (pendingRedirect) {
      if (pendingRedirect.op.startsWith('<<')) {
        if (pendingRedirect.op !== '<<<') heredocs.push({ delim: word, strip: pendingRedirect.op === '<<-' })
      } else if (!pendingRedirect.op.startsWith('<')) {
        redirects.push({ op: pendingRedirect.op, target: word })
      }
      pendingRedirect = null
    } else {
      words.push(word)
    }
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length || redirects.length) commands.push({ argv: words, redirects })
    words = []
    redirects = []
  }
  const skipHeredocs = () => {
    // i is just past a newline. Skip each pending heredoc body in order.
    for (const h of heredocs.splice(0)) {
      for (;;) {
        if (i >= src.length) return
        const nl = src.indexOf('\n', i)
        const line = src.slice(i, nl === -1 ? src.length : nl)
        i = nl === -1 ? src.length : nl + 1
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
      }
    }
  }
  /** Read a $( ... ) or ` ... ` body starting at i; returns its text and moves i past it. */
  const readSubst = (open) => {
    let depthParen = 1
    let out = ''
    let quote = null
    while (i < src.length) {
      const c = src[i]
      if (quote) {
        if (c === '\\' && quote === '"') {
          out += c + (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (c === quote) quote = null
        out += c
        i++
        continue
      }
      if (c === "'" || c === '"') {
        quote = c
        out += c
        i++
        continue
      }
      if (c === '\\') {
        out += c + (src[i + 1] ?? '')
        i += 2
        continue
      }
      if (open === '`') {
        if (c === '`') {
          i++
          return out
        }
      } else {
        if (c === '(') depthParen++
        if (c === ')' && --depthParen === 0) {
          i++
          return out
        }
      }
      out += c
      i++
    }
    return out
  }
  const substitute = (body) => {
    commands.push(...parseCommand(body, depth + 1).commands)
    word += SUBST
    inWord = true
  }

  while (i < src.length) {
    const c = src[i]

    // --- quotes and escapes -------------------------------------------------
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2
        continue
      }
      if (i + 1 < src.length) word += src[i + 1]
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      word += src.slice(i + 1, end === -1 ? src.length : end)
      inWord = true
      i = end === -1 ? src.length : end + 1
      continue
    }
    if (c === '"') {
      i++
      inWord = true
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1] ?? '')) {
          if (src[i + 1] !== '\n') word += src[i + 1]
          i += 2
        } else if (src[i] === '$' && src[i + 1] === '(') {
          i += 2
          substitute(readSubst('('))
        } else if (src[i] === '`') {
          i++
          substitute(readSubst('`'))
        } else {
          word += src[i++]
        }
      }
      i++
      continue
    }
    if (c === '$' && src[i + 1] === '(') {
      i += 2
      substitute(readSubst('('))
      continue
    }
    if (c === '`') {
      i++
      substitute(readSubst('`'))
      continue
    }

    // --- comments -----------------------------------------------------------
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }

    // --- command separators -------------------------------------------------
    if (c === '\n') {
      endCommand()
      i++
      skipHeredocs()
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      // `&>`, `&>>` are redirects, not separators.
      if (c === '&' && src[i + 1] === '>') {
        endWord()
        const op = src[i + 2] === '>' ? '&>>' : '&>'
        pendingRedirect = { op }
        i += op.length
        continue
      }
      endCommand()
      i += (c === '&' || c === '|') && src[i + 1] === c ? 2 : c === '|' && src[i + 1] === '&' ? 2 : c === ';' && src[i + 1] === ';' ? 2 : 1
      continue
    }

    // --- redirects ----------------------------------------------------------
    if (c === '>' || c === '<') {
      // A word made only of digits right before the operator is a file descriptor.
      if (inWord && /^\d+$/.test(word) && !pendingRedirect) {
        word = ''
        inWord = false
      } else {
        endWord()
      }
      let op = c
      if (c === '>') {
        if (src[i + 1] === '>') op = '>>'
        else if (src[i + 1] === '|') op = '>|'
        else if (src[i + 1] === '&') op = '>&'
      } else if (src.startsWith('<<<', i)) op = '<<<'
      else if (src.startsWith('<<-', i)) op = '<<-'
      else if (src[i + 1] === '<') op = '<<'
      else if (src[i + 1] === '(') op = '<('
      i += op.length
      if (op === '<(') {
        commands.push(...parseCommand(readSubst('('), depth + 1).commands)
        continue
      }
      if (op === '>&') {
        // `>&2` duplicates a descriptor; `>&file` is rare and treated the same.
        while (i < src.length && /[0-9-]/.test(src[i])) i++
        continue
      }
      pendingRedirect = { op }
      continue
    }

    // --- whitespace ends a word ----------------------------------------------
    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }

    // `[[ a > b ]]` compares strings; the `>` inside it is not a redirect.
    if (!inWord && words.length === 0 && src.startsWith('[[', i)) {
      const end = src.indexOf(']]', i)
      i = end === -1 ? src.length : end + 2
      words.push('[[')
      continue
    }

    word += c
    inWord = true
    i++
  }
  endCommand()

  // Leading `!` negates; assignments before the command name are not the command.
  for (const cmd of commands) {
    while (cmd.argv[0] === '!' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd.argv[0] ?? '')) cmd.argv.shift()
  }

  // Look inside nested shells and eval.
  const nested = []
  for (const cmd of commands) {
    const name = baseName(cmd.argv[0])
    if (SHELLS.has(name)) {
      const idx = cmd.argv.findIndex((a, n) => n > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
      if (idx !== -1 && cmd.argv[idx + 1] !== undefined) nested.push(...parseCommand(cmd.argv[idx + 1], depth + 1).commands)
    } else if (name === 'eval') {
      nested.push(...parseCommand(cmd.argv.slice(1).join(' '), depth + 1).commands)
    }
  }
  commands.push(...nested)
  return { commands: commands.filter((c) => c.argv.length || c.redirects.length) }
}

/** `/usr/bin/git` and `git` are the same program. */
export function baseName(word) {
  const w = String(word ?? '')
  const slash = Math.max(w.lastIndexOf('/'), w.lastIndexOf('\\'))
  return slash === -1 ? w : w.slice(slash + 1)
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/** Options that take a separate value, per wrapper. Anything else starting with - is a switch. */
const WRAPPERS = {
  env: { values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], assignments: true },
  command: { values: [], query: ['-v', '-V'] },
  sudo: { values: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'] },
  doas: { values: ['-u', '-C'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  stdbuf: { values: ['-i', '-o', '-e'] },
  nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '-n', '-p', '-P', '-u'] },
  nohup: { values: [] },
  time: { values: ['-f', '-o'] },
  exec: { values: ['-a'] },
  xargs: { values: ['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'] },
  busybox: { values: [] },
  npx: { values: ['-p', '--package'] },
  bunx: { values: [] },
  then: { values: [] },
  else: { values: [] },
  do: { values: [] },
  if: { values: [] },
  while: { values: [] },
  until: { values: [] },
  '{': { values: [] },
}

/**
 * Strip wrappers such as `env -i`, `sudo -u me`, `timeout 30`, `xargs -n1` and
 * `npx` from the front of argv, returning the argv of the program that really
 * runs. Returns null for `command -v x`, which only looks a program up.
 */
export function unwrap(argv) {
  let a = argv.map((w) => (w.startsWith('\\') ? w.slice(1) : w))
  for (let guard = 0; guard < 10 && a.length; guard++) {
    const name = baseName(a[0])
    const spec = WRAPPERS[name]
    if (!spec) break
    if (spec.query && a.slice(1).some((x) => spec.query.includes(x))) return null
    let k = 1
    let positional = spec.positional ?? 0
    while (k < a.length) {
      const w = a[k]
      if (w === '--') {
        k++
        break
      }
      if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        k++
        continue
      }
      if (w.startsWith('-') && w.length > 1) {
        const flag = w.includes('=') ? w.slice(0, w.indexOf('=')) : w
        k += spec.values.includes(flag) && !w.includes('=') ? 2 : 1
        continue
      }
      if (positional > 0) {
        positional--
        k++
        continue
      }
      break
    }
    a = a.slice(k)
  }
  return a
}
