// Notification: record that the session asked for attention (a hanging prompt). settings.json limits the
// hook to prompt types; the record names the type that fired. The message text is never sent.
import { isRemote, readInput, postEvent } from './lib.mjs'

if (!isRemote(process.env)) process.exit(0)

const input = readInput()
const type = input && typeof input.notification_type === 'string' ? input.notification_type : null
await postEvent('notification', process.env, input, { notification_type: type })
process.exit(0)
