import type { RuntimeTaskCreationReadResponse } from '@/types/api'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { readTurnReceipt } from '../../../../../shared/turnReceipt'
import type { GatewayServer } from '../../gatewayRpc'
import { record, runtimeTaskId, text } from './contracts'
import type { GatewayRuntimeCore } from './core'
import { projectPersistedThread } from './threadSnapshotTask'

/** Only read the original operation. Missing evidence never permits replay. */
export async function readTaskCreation(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  server: GatewayServer,
  assertScope: () => Promise<void>
): Promise<RuntimeTaskCreationReadResponse> {
  const workspacePath = text(params.workspacePath)
  const clientRequestId = text(params.clientRequestId)
  const clientMessageId = text(params.clientMessageId)
  if (
    params.deviceId !== server.id ||
    !workspacePath ||
    !clientRequestId ||
    clientRequestId.length > 1024 ||
    (clientMessageId?.length ?? 0) > 1024
  )
    throw new Error('Invalid original task creation identity')
  const client = await runtime.connectClient(server, 'runtime', workspacePath)
  try {
    await assertScope()
    if (!client.supportsExperimental?.('threadCreationReceiptsV1')) return { status: 'unavailable' }
    const result = await client.request<{ receipt?: unknown }>('thread/creation/read', {
      clientRequestId,
    })
    await assertScope()
    const receipt = record(result.receipt)
    const thread = record(receipt.thread)
    const threadId = text(receipt.threadId)
    if (receipt.status !== 'ready' || !threadId || thread.id !== threadId)
      return { status: 'unknown' }
    if (!sameWorkspacePath(text(thread.cwd), workspacePath))
      throw new Error('Original task creation workspace does not match')
    const taskId = runtimeTaskId(server, threadId)
    const threadKey = runtime.threadKey(server.id, threadId)

    let initialMessage: Extract<
      RuntimeTaskCreationReadResponse,
      { status: 'ready' }
    >['initialMessage'] = { status: 'unknown' }
    if (clientMessageId) {
      try {
        const { turn } = await readTurnReceipt(client, { threadId, clientMessageId })
        initialMessage = {
          status:
            turn!.status === 'failed'
              ? 'execution_failed'
              : (turn!.status as 'running' | 'completed' | 'interrupted'),
          turnId: turn!.id,
        }
      } catch {
        // A ready thread does not prove that its initial message was accepted.
      }
    }
    await assertScope()
    const existingId = runtime.taskByThread.get(threadKey)
    if ((existingId && existingId !== taskId) || runtime.taskMetadata.get(threadKey)?.deletedAt)
      return { status: 'unknown' }
    const existing = runtime.tasks.get(taskId) ?? runtime.archivedTasks.get(taskId)
    let recoveredTask = existing
    if (
      existing &&
      (existing.serverId !== server.id ||
        existing.threadId !== threadId ||
        !sameWorkspacePath(existing.workspacePath, workspacePath))
    )
      throw new Error('Original task creation owner does not match')
    if (!recoveredTask) {
      // The receipt identifies this exact thread even when its standalone
      // directory is absent from the project registry. No history scan or
      // workspace registration is needed to make the original address readable.
      const { task, archived } = projectPersistedThread(
        runtime,
        { server, workspacePath },
        thread,
        taskId
      )
      runtime.threadByTask.set(taskId, threadId)
      runtime.taskByThread.set(threadKey, taskId)
      const index = archived ? runtime.archivedTasks : runtime.tasks
      index.set(taskId, task)
      recoveredTask = task
    }
    return {
      status: 'ready',
      address: {
        deviceId: server.id,
        taskId,
        threadId,
        workspacePath,
        runtimeHandle: {
          ...recoveredTask.runtimeHandle,
          ...(recoveredTask.model || recoveredTask.modelSelectionMode === 'follow_target_default'
            ? {
                modelSelection: {
                  modelName:
                    recoveredTask.modelSelectionMode === 'follow_target_default'
                      ? ''
                      : recoveredTask.model!,
                  modelType: null,
                  options: {},
                },
              }
            : {}),
        },
      },
      initialMessage,
    }
  } finally {
    client.close()
  }
}
