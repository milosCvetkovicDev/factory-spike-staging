// PreToolUse: count every attempt at the control plane, then deny on a guard rule, an exhausted budget
// or any control-plane fault (fail closed). An allow prints nothing, so the permission rules still apply.
import { isRemote, readInput, bashRule, postEvent, appendLatency, writeOut } from './lib.mjs'

if (!isRemote(process.env)) process.exit(0)

const deny = (reason) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })

let output = ''
let input = null
try {
  input = readInput()
  const tool = input && typeof input.tool_name === 'string' ? input.tool_name : null
  const command = input && input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
  const ruleDeny = tool === 'Bash' ? bashRule(command) : null
  const res = await postEvent('pre_tool', process.env, input, { tool, rule_deny: ruleDeny })

  let reason = null
  if (ruleDeny) reason = ruleDeny
  else if (input === null) reason = 'factory-spike: unreadable hook input; failing closed'
  else if (!res.ok) reason = 'factory-spike: control plane unreachable, slow or invalid; failing closed'
  else if (res.json.stop === true) reason = 'factory-spike: the packet call budget is used up'
  else if (res.json.stop !== false) reason = 'factory-spike: control plane answer has no stop flag; failing closed'
  if (reason) output = deny(reason)
} catch {
  output = deny('factory-spike: guard hook error; failing closed')
}

appendLatency(process.env, input, Math.round(performance.now() * 10) / 10)
if (output) writeOut(output)
process.exit(0)
