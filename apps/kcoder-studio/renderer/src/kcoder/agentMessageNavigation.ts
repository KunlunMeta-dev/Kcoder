import { requestLocalExecutor } from '@/host/localExecutor'
import type { RuntimeTaskAddress } from '@/types/api'
import { validAgentMessageResolvedAddress } from '../../../shared/agentMessageMethods.mjs'
import { sessionAddressKey, type SessionAddress } from '../../../shared/peerAgentMessage'

/** Canonical IDs are resolved by the current authenticated Gateway, never interpreted as URLs or paths. */
export async function resolveAgentMessageNavigation(source: RuntimeTaskAddress, destination: SessionAddress | undefined, legacyThreadId: string): Promise<RuntimeTaskAddress> {
  if (!destination) {
    if (!source.deviceId || !source.workspacePath || !/^[A-Za-z0-9_-]{1,128}$/.test(legacyThreadId)) throw new Error('agent_message_navigation_unavailable')
    return { deviceId: source.deviceId, workspacePath: source.workspacePath, threadId: legacyThreadId,
      taskId: `kcoder:${source.deviceId}:${legacyThreadId}` }
  }
  const result = await requestLocalExecutor('runtime.agentMessages.request', { address: source, operation: 'resolve', destinationAddress: { ...destination } })
  if (!validAgentMessageResolvedAddress(result) || sessionAddressKey(result.address) !== sessionAddressKey(destination)) throw new Error('agent_message_navigation_unavailable')
  return { deviceId: result.serverId, workspacePath: result.workspacePath, threadId: result.threadId,
    taskId: `kcoder:${result.serverId}:${result.threadId}`, expectedSessionAddress: { ...result.address } }
}
