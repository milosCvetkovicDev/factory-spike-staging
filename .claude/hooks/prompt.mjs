// UserPromptSubmit: post only the packet label, never the prompt text.
import { isRemote, readInput, labelOf, postEvent } from './lib.mjs'

if (!isRemote(process.env)) process.exit(0)

const input = readInput()
await postEvent('prompt', process.env, input, { label: labelOf(input && input.prompt) })
process.exit(0)
