// SessionStart: record that the session began.
import { isRemote, readInput, postEvent } from './lib.mjs'

if (!isRemote(process.env)) process.exit(0)

await postEvent('session_start', process.env, readInput())
process.exit(0)
