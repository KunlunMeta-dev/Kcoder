import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './core'
import { text, type GatewayTask, type GatewayWorkspaceDescriptor } from './contracts'

export interface ThreadInventory {
  threads: Array<Record<string, unknown>>
  complete: boolean
  issueCount: number
  tasksBefore: Map<string, { task: GatewayTask; goalStatusObservation: GatewayTask['goalStatusObservation'] }>
}

/** One paged Native inventory and its pre-read task versions; never a retained cache. */
export async function readThreadInventory(
  runtime: Pick<GatewayRuntimeCore, 'tasks' | 'archivedTasks'>,
  workspace: Pick<GatewayWorkspaceDescriptor, 'server' | 'workspacePath'>,
  client: Pick<GatewayClient, 'request' | 'supportsExperimental'>,
  acceptPage: (page: { completeness?: 'complete' | 'partial' }) => boolean | Promise<boolean>,
): Promise<ThreadInventory | null> {
  const inventory: ThreadInventory = { threads: [], complete: true, issueCount: 0, tasksBefore: new Map() }
  for (const tasks of [runtime.tasks, runtime.archivedTasks]) {
    for (const task of tasks.values()) {
      if (task.serverId === workspace.server.id && sameWorkspacePath(task.workspacePath, workspace.workspacePath))
        inventory.tasksBefore.set(task.taskId, { task, goalStatusObservation: task.goalStatusObservation })
    }
  }
  const allowPartial = client.supportsExperimental?.('threadListCompleteness') === true
  const seen = new Set<string>()
  let cursor: string | null = null
  let metadata: { completeness: 'complete' | 'partial'; issueCount: number } | undefined
  for (let page = 0; ; page++) {
    const result = await client.request<{
      threads?: Array<Record<string, unknown>>
      nextCursor?: string | null
      completeness?: 'complete' | 'partial'
      issueCount?: number
    }>('thread/list', {
      limit: 100,
      ...(allowPartial ? { allowPartial: true } : {}),
      ...(cursor ? { cursor } : {}),
    })
    if (!(await acceptPage(result))) return null
    if (!Array.isArray(result.threads)) throw new Error('运行目标返回了无效的 thread/list 结果')
    if (allowPartial) {
      if (!['complete', 'partial'].includes(result.completeness ?? '') ||
          !Number.isSafeInteger(result.issueCount) || result.issueCount! < 0 ||
          result.completeness === 'complete' && result.issueCount !== 0)
        throw new Error('运行目标返回了无效的 thread/list 完整性状态')
      if (metadata && (metadata.completeness !== result.completeness || metadata.issueCount !== result.issueCount))
        throw new Error('运行目标的 thread/list 快照完整性在分页期间发生变化')
      metadata ??= { completeness: result.completeness!, issueCount: result.issueCount! }
    }
    inventory.complete &&= result.completeness !== 'partial'
    inventory.issueCount = result.issueCount ?? 0
    inventory.threads.push(...result.threads)
    const next = text(result.nextCursor)
    if (inventory.threads.length > 10_000 || next && (inventory.threads.length >= 10_000 || page >= 99))
      throw new Error('THREAD_LIST_INVENTORY_LIMIT_EXCEEDED')
    if (!next) return inventory
    if (seen.has(next)) throw new Error('运行目标返回了重复的 thread/list cursor')
    seen.add(next)
    cursor = next
  }
}
