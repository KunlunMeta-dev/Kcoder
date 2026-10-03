import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

export function withTimeout(promise, timeoutMs, message) {
  let timeout
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

export async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function createCommandSupport(owner, { environmentFor } = {}) {
  if (!owner?.runCommand) throw new Error('Command support requires a process resource owner')
  const commandOptions = options => ({
    ...options,
    env: options.env ?? environmentFor?.(options.profile ?? 'build', options.envOverrides),
  })
  return {
    async commandOutput(command, args, options = {}) {
      const result = await owner.runCommand(command, args, commandOptions(options))
      return result.stdout.trim()
    },
    async runChecked(command, args, options = {}) {
      console.log(`$ ${command} ${args.join(' ')}`)
      await owner.runCommand(command, args, commandOptions(options))
    },
  }
}
