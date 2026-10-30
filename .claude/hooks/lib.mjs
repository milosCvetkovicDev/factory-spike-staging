// Shared helpers for the fixture's guard hooks. Dependency-free, and importing this module has no side
// effects: every hook calls isRemote(process.env) before it touches a file or the network.
import { appendFileSync, mkdirSync, readFileSync, writeSync } from 'node:fs'
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

// POST to the control plane. ok is true only for a 2xx answer with a JSON object body. Never throws.
// status is the HTTP status, or null with error saying why there was no answer.
// The token goes in a header when FACTORY_CP_TOKEN is set; otherwise the network layer may add it.
export async function post(path, body, { env = process.env, timeoutMs = 2000 } = {}) {
  const started = performance.now()
  const done = (ok, json, status = null, error = null) =>
    ({ ok, json, status, error, ms: Math.round((performance.now() - started) * 10) / 10 })
  const base = typeof env.FACTORY_CP_URL === 'string' ? env.FACTORY_CP_URL.replace(/\/+$/, '') : ''
  if (base === '') return done(false, null, null, 'no control-plane URL')
  const isText = typeof body === 'string'
  const headers = { 'content-type': isText ? 'application/x-ndjson' : 'application/json' }
  if (env.FACTORY_CP_TOKEN) headers.authorization = `Bearer ${env.FACTORY_CP_TOKEN}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = null
  try {
    const res = await fetch(base + path, {
      method: 'POST',
      headers,
      body: isText ? body : JSON.stringify(body),
      signal: controller.signal,
    })
    status = res.status
    const text = await res.text()
    let json = null
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) json = value
    } catch {
      json = null
    }
    return done(res.ok && json !== null, json, status)
  } catch {
    return done(false, null, status, controller.signal.aborted ? `timeout after ${timeoutMs} ms` : 'request failed')
  } finally {
    clearTimeout(timer)
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
