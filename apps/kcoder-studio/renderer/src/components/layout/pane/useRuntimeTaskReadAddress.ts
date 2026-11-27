import { useMemo } from 'react'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { validAgentMessageAddress } from '../../../../../shared/agentMessageMethods.mjs'
import type { RuntimeTaskAddress } from '@/types/api'

/** Keep presentation enrichment separate from the original task's read identity. */
export function useRuntimeTaskReadAddress(current: RuntimeTaskAddress | null | undefined, retained?: RuntimeTaskAddress | null) {
  const source = current && retained && retained.deviceId === current.deviceId && retained.taskId === current.taskId
    ? retained : current
  const deviceId = source?.deviceId
  const taskId = source?.taskId
  const threadId = source?.threadId ?? runtimeThreadId(source)
  const workspacePath = source?.workspacePath
  const expected = source?.expectedSessionAddress
  const selector = validAgentMessageAddress(expected) ? expected : undefined
  const nativeTargetId = selector?.targetId
  const nativeWorkspaceId = selector?.workspaceId
  const nativeThreadId = selector?.threadId
  // Keep malformed input intact so the existing selector validation still rejects it.
  const malformedExpected = selector ? undefined : expected
  return useMemo<RuntimeTaskAddress | null>(() => {
    const expectedSessionAddress = nativeTargetId !== undefined && nativeWorkspaceId !== undefined && nativeThreadId !== undefined
      ? { targetId: nativeTargetId, workspaceId: nativeWorkspaceId, threadId: nativeThreadId } : malformedExpected
    return deviceId && taskId ? {
      deviceId, taskId,
      ...(threadId != null ? { threadId } : {}),
      ...(workspacePath != null ? { workspacePath } : {}),
      ...(expectedSessionAddress !== undefined ? { expectedSessionAddress } : {}),
    } : null
  }, [deviceId, taskId, threadId, workspacePath, nativeTargetId, nativeWorkspaceId, nativeThreadId, malformedExpected])
}
