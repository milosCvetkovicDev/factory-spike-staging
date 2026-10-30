// ConfigChange: record the change, then block it with exit 2 and the reason on stderr.
import { isRemote, readInput, postEvent, writeErr } from './lib.mjs'

if (!isRemote(process.env)) process.exit(0)

await postEvent('config_change', process.env, readInput())
writeErr('factory-spike: configuration changes are blocked in a spike session\n')
process.exit(2)
