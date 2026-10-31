// Stop: upload the transcript (a failed upload posts transcript_failed), run the stop command (npm test),
// post the gate body with the hook latencies, then record the stop event. It never blocks the stop, so it
// cannot loop.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRemote, readInput, post, postEvent, sessionOf, projectDir, stateDir, writeErr, envWithout } from './lib.mjs'

if (!isRemote(process.env)) process.exit(0)

const env = process.env
const input = readInput() || {}
const session = encodeURIComponent(sessionOf(env, input))
const dir = projectDir(env, input)

if (typeof input.transcript_path === 'string' && input.transcript_path !== '') {
  let transcript = null
  try {
    transcript = readFileSync(input.transcript_path, 'utf8')
  } catch {
    transcript = null
  }
  if (transcript !== null) {
    // A lost transcript (413 over 5 MiB, 401, timeout) is recorded, not silent (T-04); the stop goes on.
    const res = await post(`/v1/transcripts/${session}`, transcript, { env, timeoutMs: 20000 })
    if (res.status === null || res.status < 200 || res.status > 299) {
      const bytes = Buffer.byteLength(transcript, 'utf8')
      const reason = res.error || `HTTP ${res.status}`
      try {
        writeErr(`factory-spike stop: transcript upload failed (status ${res.status}, ${bytes} bytes): ${reason}\n`)
      } catch {
        // a closed stderr must not cost the gate and stop posts
      }
      await postEvent('transcript_failed', env, input, { status: res.status, bytes, reason })
    }
  }
}

// The test script is repository code the agent wrote: it gets the environment without any FACTORY_CP_*
// variable and without any value that holds the token, so the control-plane URL and token stay with the
// hook's own posts. git gets the same environment.
const STOP_CMD = 'npm test'
const testEnv = envWithout(env)
const run = spawnSync('npm', ['test'], { cwd: dir, env: testEnv, timeout: 50000, maxBuffer: 64 * 1024 * 1024 })
const stopExit = typeof run.status === 'number' ? run.status : 1
const output = Buffer.concat([run.stdout || Buffer.alloc(0), run.stderr || Buffer.alloc(0)])

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: dir, env: testEnv, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null
}
const baseSha = git('merge-base', 'HEAD', 'origin/main') || git('rev-list', '--max-parents=0', 'HEAD')

let latency = []
try {
  latency = readFileSync(join(stateDir(env, input), 'latency.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line).ms
      } catch {
        return null
      }
    })
    .filter((ms) => typeof ms === 'number' && Number.isFinite(ms))
} catch {
  latency = []
}

await post(`/v1/gate/${session}`, {
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  base_sha: baseSha,
  head_sha: git('rev-parse', 'HEAD'),
  tree_sha: git('rev-parse', 'HEAD^{tree}'),
  stop_cmd: STOP_CMD,
  stop_exit: stopExit,
  stop_output_sha256: createHash('sha256').update(output).digest('hex'),
  latency_ms: latency,
}, { env, timeoutMs: 5000 })

await postEvent('stop', env, input)
process.exit(0)
