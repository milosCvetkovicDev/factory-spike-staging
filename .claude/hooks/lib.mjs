// Shared helpers for the fixture's guard hooks. Dependency-free, and importing this module has no side
// effects: every hook calls isRemote(process.env) before it touches a file or the network.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// True only inside a cloud session.
export const isRemote = (env) => Boolean(env) && env.CLAUDE_CODE_REMOTE === 'true'

// The packet label from a `SPIKE-LABEL: S<n>` line. A trailing CR and a leading BOM are tolerated.
export function labelOf(prompt) {
  if (typeof prompt !== 'string') return null
  const m = /^SPIKE-LABEL: (S[0-9])\r?$/m.exec(prompt.replace(/^\uFEFF/, ''))
  return m ? m[1] : null
}

const GUARDED = ['.claude', '.mcp.json', 'canary', '.factory-spike']

// The command text as the shell would see the words: ANSI-C and plain quotes, and backslash escapes,
// removed, folded to lower case.
export function normalizeCommand(command) {
  return String(command)
    .normalize('NFKC')
    .replace(/\$(?=['"])/g, '')
    .replace(/['"\\]/g, '')
    .toLowerCase()
}

const escapeRe = (s) => s.replace(/[.+^$()|\\/{}[\]*?]/g, '\\$&')

// A shell glob segment (*, ?, [...], {a,b}) as an anchored regular expression.
function globToRegExp(glob) {
  const convert = (s) => {
    let out = ''
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === '*') out += '.*'
      else if (c === '?') out += '.'
      else if (c === '[') {
        const end = s.indexOf(']', i + 2)
        if (end < 0) { out += '\\['; continue }
        let body = s.slice(i + 1, end)
        const negate = body[0] === '!' || body[0] === '^'
        if (negate) body = body.slice(1)
        out += `[${negate ? '^' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`
        i = end
      } else if (c === '{') {
        const end = s.indexOf('}', i + 1)
        const inner = end < 0 ? '' : s.slice(i + 1, end)
        if (end < 0 || !inner.includes(',')) { out += '\\{'; continue }
        out += `(?:${inner.split(',').map(convert).join('|')})`
        i = end
      } else out += escapeRe(c)
    }
    return out
  }
  try {
    return new RegExp(`^${convert(glob)}$`)
  } catch {
    return /^.*$/ // an unparseable pattern is treated as matching everything (fail closed)
  }
}

// A deny reason when a Bash command names a guarded path, directly, quoted, escaped or through a glob.
export function bashRule(command) {
  if (typeof command !== 'string' || command.trim() === '') return null
  if (/\$'[^']*\\/.test(command)) return 'factory-spike: Bash command uses ANSI-C escapes, which can hide a guarded path'
  const text = normalizeCommand(command)
  for (const name of GUARDED) {
    if (text.includes(name)) return `factory-spike: Bash command names a guarded path (${name})`
  }
  if (/dotglob|globignore/.test(text)) return 'factory-spike: Bash command changes dot-file globbing'
  for (const word of text.split(/[\s;&|<>()`=]+/)) {
    if (!/[*?[{]/.test(word)) continue
    for (const seg of word.split('/')) {
      if (!/[*?[{]/.test(seg)) continue
      const re = globToRegExp(seg)
      for (const name of GUARDED) {
        // A shell glob matches a leading dot only when the pattern starts with one.
        if (name.startsWith('.') && !seg.startsWith('.') && !seg.startsWith('{')) continue
        if (re.test(name)) return `factory-spike: Bash command names a guarded path through a pattern (${name})`
      }
    }
  }
  return null
}

// The control-plane base from FACTORY_CP_URL: an http(s) URL without credentials, query or fragment, so
// the host and path a deny reason names carry nothing secret.
function controlPlaneUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return { error: 'no-url: FACTORY_CP_URL is unset' }
  let u = null
  try {
    u = new URL(raw)
  } catch {
    u = null
  }
  if (u === null || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '' || /[?#]/.test(raw)) {
    return { error: 'no-url: FACTORY_CP_URL is not a plain http(s) URL' }
  }
  const prefix = u.pathname.replace(/\/+$/, '')
  return { base: u.origin + prefix, target: u.host + prefix }
}

// True when text holds the token or any 8-byte slice of it (the whole token when it is shorter).
function holdsTokenPart(text, token) {
  if (token === '') return false
  const n = Math.min(8, token.length)
  for (let i = 0; i + n <= token.length; i++) if (text.includes(token.slice(i, i + n))) return true
  return false
}

// curl's own error line ("curl: (7) Failed to connect ..."), the last one, as printable ASCII of at most 200
// characters, with any user:password@ removed. A line that holds any part of the token is withheld.
function curlLine(stderr, token) {
  const line = stderr.split('\n').map((l) => l.trim()).reverse().find((l) => /^curl: \(\d+\) /.test(l))
  if (line === undefined) return 'no error line'
  const text = line.replace(/^curl: \(\d+\) /, '').replace(/[^\x20-\x7e]/g, ' ')
    .replace(/[^\s/@]+:[^\s/@]*@/g, '[credentials]@').slice(0, 200)
  return holdsTokenPart(line, token) || holdsTokenPart(text, token) ? 'error line withheld (it held part of the token)' : text
}

// The environment for a child: without any FACTORY_CP_ variable and without any variable whose value holds
// the token, so an alias such as an OTLP header variable does not carry it either.
export function envWithout(env, token = typeof env.FACTORY_CP_TOKEN === 'string' ? env.FACTORY_CP_TOKEN : '') {
  return Object.fromEntries(Object.entries(env)
    .filter(([key, value]) => !key.startsWith('FACTORY_CP_') && !(token !== '' && String(value).includes(token))))
}

const ANSWER_MAX = 1048576

function removeDir(dir) {
  if (dir === null) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // a leftover body file holds no token; the post's answer stands
  }
}

// POST to the control plane through curl, which honours the proxy variables and the system CA store of a
// cloud session; Node's fetch honours neither (spike/FACTS.md). ok is true only for a 2xx answer with a
// JSON object body. Never throws. status is the HTTP status or null. When ok is false, error names the
// cause with safe facts only: no-url, bad-token, temp file failed, curl not started, curl killed,
// curl exit <n>: <curl's error line> or http <status>; target is host and path once the URL is usable.
// The token goes to curl on stdin (-H @-), never in its argv or environment, and no error carries any part
// of it; without FACTORY_CP_TOKEN no header is sent and the network layer may add it.
export async function post(path, body, { env = process.env, timeoutMs = 2000 } = {}) {
  const started = performance.now()
  const url = controlPlaneUrl(env.FACTORY_CP_URL)
  const target = url.error ? null : url.target + String(path).split(/[?#]/)[0]
  const done = (ok, json, status = null, error = null) =>
    ({ ok, json, status, error, target, ms: Math.round((performance.now() - started) * 10) / 10 })
  if (url.error) return done(false, null, null, url.error)
  const token = typeof env.FACTORY_CP_TOKEN === 'string' ? env.FACTORY_CP_TOKEN : ''
  if (token !== '' && !/^[\x21-\x7e]+$/.test(token)) return done(false, null, null, 'bad-token: FACTORY_CP_TOKEN is not a header-safe value')
  const isText = typeof body === 'string'
  let dir = null
  let bodyFile = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'factory-spike-post-'))
    bodyFile = join(dir, 'body')
    writeFileSync(bodyFile, isText ? body : JSON.stringify(body), { mode: 0o600 })
  } catch (e) {
    removeDir(dir)
    return done(false, null, null, `temp file failed: ${(e && e.code) || 'error'}`)
  }
  try {
    // -q first, so a ~/.curlrc cannot change the request; the connect timeout sits inside --max-time;
    // --globoff keeps [ ] in the URL from expanding into several requests.
    const args = ['-q', '--silent', '--show-error', '--globoff', '--proto', '=http,https',
      '--max-time', String(timeoutMs / 1000), '--connect-timeout', String(Math.round(timeoutMs * 0.75) / 1000),
      '--max-filesize', String(ANSWER_MAX),
      '--header', `content-type: ${isText ? 'application/x-ndjson' : 'application/json'}`, '--header', 'Expect:',
      '--data-binary', `@${bodyFile}`, '--write-out', '\n%{http_code}']
    if (token !== '') args.push('--header', '@-')
    args.push('--url', url.base + path)
    // curl gets the hook's environment without the token (envWithout), in the C locale, so --connect-timeout 1.5
    // parses the same everywhere and the error line is in English.
    const childEnv = { ...envWithout(env, token), LC_ALL: 'C' }
    const run = await new Promise((resolve) => {
      const out = []
      const err = []
      let settled = false
      let killer = null
      const finish = (r) => {
        if (settled) return
        settled = true
        clearTimeout(killer)
        resolve(r)
      }
      let child
      try {
        child = spawn('curl', args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e) {
        return finish({ spawnError: (e && e.code) || 'error' })
      }
      // A curl that outlives --max-time, or answers more than ANSWER_MAX, is killed, and the post gives up
      // at once, even if a grandchild still holds the pipes.
      const kill = (why) => {
        child.kill('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
        finish({ code: null, signal: 'SIGKILL', why })
      }
      killer = setTimeout(() => kill(''), timeoutMs + 1000)
      let bytes = 0
      const collect = (into) => (c) => {
        bytes += c.length
        if (bytes > ANSWER_MAX + 4096) kill(' (answer over 1 MiB)')
        else into.push(c)
      }
      child.on('error', (e) => finish({ spawnError: (e && e.code) || 'error' }))
      child.stdout.on('error', () => {})
      child.stderr.on('error', () => {})
      child.stdout.on('data', collect(out))
      child.stderr.on('data', collect(err))
      child.on('close', (code, signal) =>
        finish({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))
      child.stdin.on('error', () => {})
      child.stdin.end(token !== '' ? `Authorization: Bearer ${token}\n` : '')
    })
    if (run.spawnError) return done(false, null, null, `curl not started: ${run.spawnError}`)
    if (run.code === null) return done(false, null, null, `curl killed by ${run.signal}${run.why || ''}`)
    if (run.code !== 0) return done(false, null, null, `curl exit ${run.code}: ${curlLine(run.stderr, token)}`)
    const nl = run.stdout.lastIndexOf('\n')
    const status = Number(run.stdout.slice(nl + 1))
    if (nl < 0 || !Number.isInteger(status) || status < 100 || status > 599) return done(false, null, null, 'curl exit 0: no HTTP status')
    if (status < 200 || status > 299) return done(false, null, status, `http ${status}`)
    let json = null
    try {
      const value = JSON.parse(run.stdout.slice(0, nl))
      if (value && typeof value === 'object' && !Array.isArray(value)) json = value
    } catch {
      json = null
    }
    return json === null ? done(false, null, status, `http ${status}: not a JSON object`) : done(true, json, status)
  } catch (e) {
    return done(false, null, null, `curl not started: ${(e && e.code) || 'error'}`)
  } finally {
    removeDir(dir)
  }
}

// The hook input from stdin as an object, or null when it is not a JSON object.
export function readInput() {
  try {
    const value = JSON.parse(readFileSync(0, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export const projectDir = (env, input) =>
  env.CLAUDE_PROJECT_DIR || (input && typeof input.cwd === 'string' && input.cwd) || process.cwd()

export const stateDir = (env, input) => join(projectDir(env, input), '.factory-spike')

// The cloud session id, else the local one, so every record of a session shares one key.
export const sessionOf = (env, input) =>
  env.CLAUDE_CODE_REMOTE_SESSION_ID || (input && typeof input.session_id === 'string' && input.session_id) || 'unknown'

export function eventBody(type, env, input, extra = {}) {
  return {
    v: 1,
    type,
    session: sessionOf(env, input),
    local_session: input && typeof input.session_id === 'string' ? input.session_id : null,
    ...extra,
  }
}

export const postEvent = (type, env, input, extra = {}) =>
  post('/v1/events', eventBody(type, env, input, extra), { env })

export function appendLatency(env, input, ms) {
  try {
    const dir = stateDir(env, input)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'latency.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ms })}\n`)
  } catch {
    // the latency record is evidence, never a reason to change a decision
  }
}

// stdout writes to a pipe are asynchronous on macOS; a synchronous write survives process.exit.
export const writeOut = (text) => writeSync(1, text)
export const writeErr = (text) => writeSync(2, text)
