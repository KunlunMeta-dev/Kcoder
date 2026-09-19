import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import { runtimeMethodForCurrentHost } from '@/kcoder/legacyRuntimeAbi'

interface CodexInstructionsResponse {
  instructions?: unknown
  configPath?: unknown
}

export interface CodexInstructions {
  instructions: string
  configPath: string | null
}

function normalizeCodexInstructions(response: CodexInstructionsResponse): CodexInstructions {
  return {
    instructions: typeof response.instructions === 'string' ? response.instructions : '',
    configPath: typeof response.configPath === 'string' ? response.configPath : null,
  }
}

export async function getLocalCodexInstructions(deviceId?: string): Promise<CodexInstructions> {
  await ensureLocalExecutorStarted()
  const method = runtimeMethodForCurrentHost('instructionsRead')
  const response = deviceId
    ? await requestLocalExecutor<CodexInstructionsResponse>(method, { deviceId })
    : await requestLocalExecutor<CodexInstructionsResponse>(method)
  return normalizeCodexInstructions(response)
}

export async function saveLocalCodexInstructions(
  instructions: string,
  deviceId?: string
): Promise<CodexInstructions> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<CodexInstructionsResponse>(
    runtimeMethodForCurrentHost('instructionsWrite'),
    { instructions, ...(deviceId ? { deviceId } : {}) }
  )
  return normalizeCodexInstructions(response)
}
