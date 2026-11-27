import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/host/localExecutor'
import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import { runtimeMethodForCurrentHost } from '@/kcoder/legacyRuntimeAbi'

export type CodexPersonality = 'friendly' | 'pragmatic'

export const DEFAULT_CODEX_PERSONALITY: CodexPersonality = 'pragmatic'

interface CodexPersonalityResponse {
  personality?: unknown
}

function normalizePersonality(response: CodexPersonalityResponse): CodexPersonality {
  return response.personality === 'friendly' || response.personality === 'pragmatic'
    ? response.personality
    : DEFAULT_CODEX_PERSONALITY
}

export async function getLocalCodexPersonality(deviceId?: string, expected?: { targetScope: string }): Promise<CodexPersonality> {
  if (!isKCoderGatewayPage()) await ensureLocalExecutorStarted()
  const method = runtimeMethodForCurrentHost('personalityRead')
  const response = deviceId
    ? await requestLocalExecutor<CodexPersonalityResponse>(method, { deviceId, ...(expected ? { targetScope: expected.targetScope } : {}) })
    : await requestLocalExecutor<CodexPersonalityResponse>(method)
  return normalizePersonality(response)
}

export async function saveLocalCodexPersonality(
  personality: CodexPersonality,
  deviceId?: string,
  expected?: { targetScope: string }
): Promise<CodexPersonality> {
  if (!isKCoderGatewayPage()) await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<CodexPersonalityResponse>(
    runtimeMethodForCurrentHost('personalityWrite'),
    { personality, ...(deviceId ? { deviceId } : {}), ...(expected ? { targetScope: expected.targetScope } : {}) }
  )
  return normalizePersonality(response)
}
