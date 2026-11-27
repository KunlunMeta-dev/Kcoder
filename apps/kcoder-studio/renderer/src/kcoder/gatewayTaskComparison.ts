import i18n from '@/i18n'
import { captureAccountContextRevision } from './accountContextEvents'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import {
  TASK_COMPARISON_CAPABILITY,
  TASK_COMPARISON_METHODS,
} from '@/features/task-comparison/controller'

export const TASK_COMPARISON_CAPABILITIES = 'runtime.worktrees.comparison.capabilities'
export function isTaskComparisonRequest(method: string, params: Record<string, unknown>) {
  return (
    method === TASK_COMPARISON_CAPABILITIES ||
    Object.values(TASK_COMPARISON_METHODS).some(value => value === method) ||
    (typeof params.comparisonOwnerTaskId === 'string' &&
      ['runtime.worktrees.prepare', 'runtime.worktrees.list'].includes(method))
  )
}

/** Pure registry operations retain owner A; candidate B never grants turn ownership. */
export async function requestTaskComparison(
  this: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>
) {
  const ownerTaskId = text(params.comparisonOwnerTaskId)
  const deviceId = text(params.deviceId)
  const ownerThreadId = text(params.ownerThreadId)
  const sourcePath = text(params.sourcePath)
  if (!ownerTaskId || !deviceId || !ownerThreadId || !sourcePath)
    throw new Error(i18n.t('taskComparison:errors.task_mismatch'))
  const validAccount = captureAccountContextRevision()
  const ownerGeneration = this.workspaceScanGeneration
  const { task, server, client, taskId } = await this.taskConnection({
    taskId: ownerTaskId,
    deviceId,
    threadId: ownerThreadId,
  })
  const assertCurrent = () => {
    const current = this.tasks.get(taskId)
    if (
      this.disposed ||
      this.workspaceScanGeneration !== ownerGeneration ||
      !validAccount(deviceId) ||
      server.id !== deviceId ||
      current?.threadId !== ownerThreadId ||
      task.threadId !== ownerThreadId ||
      current.serverId !== deviceId ||
      !sameWorkspacePath(task.workspacePath, sourcePath) ||
      !sameWorkspacePath(current.workspacePath, sourcePath) ||
      this.clientByTask.get(taskId) !== client
    )
      throw new Error(i18n.t('taskComparison:errors.scope_changed'))
  }
  assertCurrent()
  const supported = client.supportsExperimental?.(TASK_COMPARISON_CAPABILITY) === true
  if (method === TASK_COMPARISON_CAPABILITIES) return { supported }
  if (!supported) throw new Error(i18n.t('taskComparison:unsupported'))
  const wire = { ...params }
  delete wire.comparisonOwnerTaskId
  if (method === 'runtime.worktrees.prepare' || method === 'runtime.worktrees.list')
    delete wire.ownerThreadId
  if (method === TASK_COMPARISON_METHODS.bind) {
    const alternativeId = this.resolveTaskId(text(params.taskId))
    const alternative = alternativeId ? this.tasks.get(alternativeId) : undefined
    if (
      !alternative ||
      alternative.serverId !== deviceId ||
      alternative.threadId !== params.threadId ||
      !sameWorkspacePath(alternative.workspacePath, text(params.path) ?? '') ||
      alternative.threadId === ownerThreadId
    ) {
      throw new Error(i18n.t('taskComparison:errors.task_mismatch'))
    }
    const listed = record(await client.request('runtime.worktrees.list', { deviceId }))
    assertCurrent()
    const worktree = (Array.isArray(listed.items) ? listed.items.map(record) : []).find(
      item => item.path === alternative.workspacePath
    )
    if (!worktree || worktree.revision !== params.expectedRevision)
      throw new Error(i18n.t('taskComparison:errors.task_mismatch'))
    const linked = (
      Array.isArray(worktree.conversations) ? worktree.conversations.map(record) : []
    ).some(
      conversation =>
        conversation.deviceId === deviceId &&
        conversation.taskId === alternative.taskId &&
        conversation.threadId === alternative.threadId &&
        conversation.workspacePath === alternative.workspacePath
    )
    if (!linked) {
      const receipt = record(
        await client.request('runtime.worktrees.conversations.link', {
          deviceId,
          path: alternative.workspacePath,
          conversation: {
            deviceId,
            taskId: alternative.taskId,
            threadId: alternative.threadId,
            workspacePath: alternative.workspacePath,
            title: alternative.title,
            model: alternative.model ?? null,
            createdAt: alternative.createdAt,
            updatedAt: alternative.updatedAt,
          },
        })
      )
      assertCurrent()
      if (receipt.linked !== true || typeof receipt.revision !== 'number')
        throw new Error(i18n.t('taskComparison:errors.invalid_response'))
      wire.expectedRevision = receipt.revision
    }
    wire.taskId = alternative.taskId
  }
  const result = await client.request(method, wire)
  assertCurrent()
  return result
}
