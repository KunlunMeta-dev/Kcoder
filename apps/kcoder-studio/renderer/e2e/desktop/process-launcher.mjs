import { createProcessEnvironment } from './process-lifecycle.mjs'

export function createOwnedProcessLauncher({
  owner,
  sourceEnv = process.env,
  environmentFactory = createProcessEnvironment,
}) {
  if (!owner?.spawnProcess || !owner?.captureProcessOutput) {
    throw new Error('Desktop process launcher requires a process resource owner')
  }

  return {
    async launch({
      command,
      args = [],
      profile,
      env,
      envOverrides,
      logPath,
      secrets = [],
      cleanup = 'group',
      resourceName,
      ...options
    }) {
      const child = await owner.spawnProcess(command, args, {
        ...options,
        cleanup,
        env: env ?? environmentFactory(profile, sourceEnv, envOverrides),
        resourceName,
      })
      if (logPath) {
        owner.captureProcessOutput(child.stdout, logPath, { secrets })
        owner.captureProcessOutput(child.stderr, logPath, { secrets })
      }
      return child
    },
  }
}
