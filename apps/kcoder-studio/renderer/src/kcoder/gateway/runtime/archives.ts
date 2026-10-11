import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import {
  type GatewayTask,
  type GatewayTaskMetadata,
  type GatewayThreadMetadataPatch,
  MAX_TASK_METADATA_ENTRIES,
  record,
  runtimeProjectKey,
  serverIdFromRuntimeProjectKey,
  TASK_METADATA_KEY,
  text,
} from './contracts'
import type { GatewayRuntimeCore } from './core'

export function persistLocalTaskMetadata(
  this: GatewayRuntimeCore,
  key: string,
  metadata: GatewayTaskMetadata
) {
  const next = new Map(this.taskMetadata)
  next.set(key, metadata)
  const retained = [...next.entries()]
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_TASK_METADATA_ENTRIES)
  localStorage.setItem(TASK_METADATA_KEY, JSON.stringify(Object.fromEntries(retained)))
  this.taskMetadata.clear()
  for (const [entryKey, entry] of retained) this.taskMetadata.set(entryKey, entry)
}

export async function updateTaskMetadata(
  this: GatewayRuntimeCore,
  task: GatewayTask,
  patch: GatewayThreadMetadataPatch,
  metadata: GatewayTaskMetadata
) {
  if (task.ephemeral) return
  const server = (await this.servers()).find(item => item.id === task.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
  const remotePatch: GatewayThreadMetadataPatch = patch
  if (Object.keys(remotePatch).length > 0) {
    const update = (client: GatewayClient) =>
      client.request('thread/metadata/update', { threadId: task.threadId, ...remotePatch })
    const activeClient = this.clientByTask.get(task.taskId)
    if (activeClient) await update(activeClient)
    else {
      await this.withTransientClient(server, update, task.workspacePath)
    }
  }
  this.persistLocalTaskMetadata(this.threadKey(task.serverId, task.threadId), metadata)
}

export async function storedTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const address = record(params.address)
  const requestedTaskId = text(params.taskId) ?? text(address.taskId)
  let taskId = this.resolveTaskId(requestedTaskId)
  let task = taskId ? (this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)) : undefined
  if (!task && this.compatibility.isRuntimeTaskId(requestedTaskId)) {
    await this.hydrateAllPersistedTasks()
    taskId = this.resolveTaskId(requestedTaskId)
    task = taskId ? (this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)) : undefined
  }
  if (!taskId || !task) throw new Error('任务地址不存在或尚未恢复')
  return { taskId, task }
}

export async function renameTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task } = await this.storedTask(params)
  const title = text(params.title)
  if (!title) throw new Error('任务标题不能为空')
  const normalizedTitle = title.slice(0, 200)
  const updatedAt = Date.now()
  const nextTask = { ...task, title: normalizedTitle, updatedAt }
  await this.updateTaskMetadata(
    task,
    { title: normalizedTitle },
    {
      ...this.taskMetadata.get(this.threadKey(task.serverId, task.threadId)),
      title: normalizedTitle,
      updatedAt,
    }
  )
  if (this.tasks.has(taskId)) this.tasks.set(taskId, nextTask)
  if (this.archivedTasks.has(taskId)) this.archivedTasks.set(taskId, nextTask)
  return { accepted: true, taskId, workspacePath: task.workspacePath }
}

export async function archiveTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task: resolvedTask } = await this.storedTask(params)
  // Share hydration's queue so a pre-mutation list response cannot undo the archive projection.
  return this.withWorkspaceOperation(
    resolvedTask.serverId,
    resolvedTask.workspacePath,
    async () => {
      const task = this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)
      if (!task) throw new Error('任务地址不存在或尚未恢复')
      if (this.activeTurnByTask.has(taskId)) {
        throw new Error('任务运行中，暂时无法归档')
      }
      if (this.archivedTasks.has(taskId)) {
        return { accepted: true, taskId, workspacePath: task.workspacePath }
      }
      const updatedAt = Date.now()
      await this.updateTaskMetadata(
        task,
        { archivedAt: new Date(updatedAt).toISOString() },
        {
          ...this.taskMetadata.get(this.threadKey(task.serverId, task.threadId)),
          title: task.title,
          archivedAt: updatedAt,
          updatedAt,
        }
      )
      const taskClient = this.clientByTask.get(taskId)
      this.clientByTask.delete(taskId)
      taskClient?.close()
      this.tasks.delete(taskId)
      this.archivedTasks.set(taskId, { ...task, running: false, updatedAt })
      return { accepted: true, taskId, workspacePath: task.workspacePath }
    }
  )
}

export async function listArchivedTasks(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const servers = await this.servers()
  await this.hydratePersistedTasks(await this.workspaceDescriptors(servers, await this.server()))
  await this.hydrateArchivedWorktreeTasks(servers)
  const serverById = new Map(servers.map(server => [server.id, server]))
  const requestedDeviceId = text(params.deviceId)
  const requestedWorkspace = text(params.workspacePath)
  const requestedProjectKey = text(params.runtimeProjectKey)
  const requestedServerFromProject = serverIdFromRuntimeProjectKey(requestedProjectKey)
  const search = (text(params.search) ?? '').toLocaleLowerCase()
  const items = [...this.archivedTasks.values()]
    .filter(task => !requestedDeviceId || task.serverId === requestedDeviceId)
    .filter(task => !requestedServerFromProject || task.serverId === requestedServerFromProject)
    .filter(
      task => !requestedWorkspace || sameWorkspacePath(task.workspacePath, requestedWorkspace)
    )
    .filter(
      task => !search || `${task.title}\n${task.workspacePath}`.toLocaleLowerCase().includes(search)
    )
    .map(task => {
      const server = serverById.get(task.serverId)
      return {
        id: this.threadKey(task.serverId, task.threadId),
        taskId: task.taskId,
        threadId: task.threadId,
        title: task.title,
        projectKey: task.projectKey ?? runtimeProjectKey(task.serverId),
        projectName: task.projectName ?? server?.label ?? task.serverId,
        workspacePath: task.workspacePath,
        workspaceKind: 'workspace',
        runtimeHandle: task.runtimeHandle,
        deviceId: task.serverId,
        deviceName: server?.label ?? task.serverId,
        source: 'local' as const,
        runtime: task.runtime,
        createdAt: new Date(task.createdAt).toISOString(),
        updatedAt: new Date(task.updatedAt).toISOString(),
      }
    })
  if (params.sort === 'alphabetical') {
    items.sort((left, right) => left.title.localeCompare(right.title))
  } else if (params.sort === 'created') {
    items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  } else {
    items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }
  const groups = new Map<string, { projectKey: string; projectName: string; count: number }>()
  for (const item of items) {
    const existing = groups.get(item.projectKey)
    if (existing) existing.count += 1
    else {
      groups.set(item.projectKey, {
        projectKey: item.projectKey,
        projectName: item.projectName,
        count: 1,
      })
    }
  }
  return { items, projectGroups: [...groups.values()], total: items.length }
}

export async function unarchiveTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task: resolvedTask } = await this.storedTask(params)
  return this.withWorkspaceOperation(
    resolvedTask.serverId,
    resolvedTask.workspacePath,
    async () => {
      const task = this.archivedTasks.get(taskId) ?? this.tasks.get(taskId)
      if (!task) throw new Error('任务地址不存在或尚未恢复')
      if (!this.archivedTasks.has(taskId)) {
        return { accepted: true, taskId, workspacePath: task.workspacePath }
      }
      const key = this.threadKey(task.serverId, task.threadId)
      const previous = this.taskMetadata.get(key)
      const updatedAt = Date.now()
      await this.restoreArchivedTaskWorkspace(task)
      await this.updateTaskMetadata(
        task,
        { archivedAt: null },
        {
          ...(previous?.title ? { title: previous.title } : {}),
          ...(previous?.deletedAt ? { deletedAt: previous.deletedAt } : {}),
          updatedAt,
        }
      )
      await this.removeArchivedWorktreeConversation(task)
      this.archivedTasks.delete(taskId)
      this.tasks.set(taskId, { ...task, updatedAt })
      this.threadByTask.set(taskId, task.threadId)
      this.taskByThread.set(key, taskId)
      return { accepted: true, taskId, workspacePath: task.workspacePath }
    }
  )
}

export async function deleteArchivedTask(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const { taskId, task } = await this.storedTask(params)
  if (!this.archivedTasks.has(taskId)) throw new Error('只能永久删除已归档任务')
  const server = (await this.servers()).find(item => item.id === task.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
  return this.withWorkspaceOperation(task.serverId, task.workspacePath, async () => {
    await this.restoreArchivedTaskWorkspace(task)
    await this.removeArchivedWorktreeConversation(task)
    const result = await this.withTransientClient(
      server,
      client =>
        client.request<{ deleted?: boolean }>('thread/delete', {
          threadId: task.threadId,
        }),
      task.workspacePath
    )
    if (result.deleted !== true) throw new Error('KCoder app-server 未确认删除历史会话')
    const key = this.threadKey(task.serverId, task.threadId)
    const updatedAt = Date.now()
    this.persistLocalTaskMetadata(key, {
      ...this.taskMetadata.get(key),
      title: task.title,
      archivedAt: this.taskMetadata.get(key)?.archivedAt ?? updatedAt,
      deletedAt: updatedAt,
      updatedAt,
    })
    this.archivedTasks.delete(taskId)
    this.tasks.delete(taskId)
    this.threadByTask.delete(taskId)
    this.taskByThread.delete(key)
    return { accepted: true, deleted: true, taskId, workspacePath: task.workspacePath }
  })
}

export async function deleteArchivedTasksBulk(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const items = Array.isArray(params.items) ? params.items : []
  const results: Array<Record<string, unknown>> = []
  let acceptedCount = 0
  for (const item of items) {
    try {
      const result = (await this.deleteArchivedTask(record(item))) as Record<string, unknown>
      results.push(result)
      acceptedCount += 1
    } catch (error) {
      results.push({
        accepted: false,
        taskId: text(record(item).taskId),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    accepted: acceptedCount === items.length,
    requestedCount: items.length,
    acceptedCount,
    deletedCount: acceptedCount,
    results,
  }
}

export async function cleanupArchivedTasks(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  deleteTargets: boolean
) {
  await this.hydrateAllPersistedTasks()
  const addresses = Array.isArray(params.items) ? params.items.map(record) : []
  const results: Array<Record<string, unknown>> = []
  for (const address of addresses) {
    const requestedTaskId = text(address.taskId)
    const taskId = this.resolveTaskId(requestedTaskId)
    const task = taskId ? this.archivedTasks.get(taskId) : undefined
    if (!taskId || !task) {
      results.push({
        taskId: requestedTaskId ?? '',
        workspacePath: text(address.workspacePath) ?? '',
        targetCount: 0,
        cleanableCount: 0,
        skippedCount: 0,
        errorCount: 1,
        bytes: 0,
        items: [],
        error: '已归档任务不存在',
      })
      continue
    }
    const server = (await this.servers()).find(item => item.id === task.serverId)
    if (!server) {
      results.push({
        taskId,
        workspacePath: task.workspacePath,
        targetCount: 0,
        cleanableCount: 0,
        skippedCount: 0,
        errorCount: 1,
        bytes: 0,
        items: [],
        error: `任务服务器已不存在：${task.serverId}`,
      })
      continue
    }
    try {
      const client = await this.commandClient(server)
      const listed = await client.request<{ items?: Array<Record<string, unknown>> }>(
        'runtime.worktrees.list',
        { deviceId: server.id, measureBytes: !deleteTargets }
      )
      const managed = (Array.isArray(listed.items) ? listed.items : [])
        .map(record)
        .find(item => sameWorkspacePath(text(item.path), task.workspacePath))
      if (!managed) {
        results.push({
          taskId,
          workspacePath: task.workspacePath,
          targetCount: 0,
          cleanableCount: 0,
          skippedCount: 0,
          errorCount: 0,
          bytes: 0,
          items: [],
        })
        continue
      }
      const measuredBytes = deleteTargets ? 0 : Math.max(0, Number(managed.bytes) || 0)
      let status = 'preview'
      let error: string | null = null
      if (deleteTargets) {
        try {
          await client.request('gateway/workspace/release', { workspacePath: task.workspacePath })
          const previewResult = await client.request<{ preview?: Record<string, unknown> }>(
            'runtime.worktrees.archive.preview',
            {
              deviceId: server.id,
              path: task.workspacePath,
            }
          )
          const preview = record(previewResult.preview)
          if (preview.archiveAllowed !== true || preview.requiresConfirmation === true) {
            throw new Error('工作树包含需要人工确认的内容，已跳过自动清理')
          }
          const revision = Number(preview.revision)
          const contentToken = text(preview.contentToken)
          if (!Number.isSafeInteger(revision) || !contentToken) {
            throw new Error('工作树归档预检结果无效')
          }
          await client.request('runtime.worktrees.archive', {
            deviceId: server.id,
            path: task.workspacePath,
            expectedRevision: revision,
            expectedContentToken: contentToken,
            riskAccepted: false,
            archivedConversations: this.worktreeConversationReferences(
              server.id,
              task.workspacePath
            ),
          })
          status = 'cleaned'
        } catch (cleanupError) {
          status = 'failed'
          error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }
      }
      results.push({
        taskId,
        workspacePath: task.workspacePath,
        targetCount: 1,
        cleanableCount: error ? 0 : 1,
        skippedCount: 0,
        errorCount: error ? 1 : 0,
        bytes: measuredBytes,
        items: [
          {
            kind: 'worktree',
            path: task.workspacePath,
            exists: managed.state === 'active',
            bytes: measuredBytes,
            status,
            ...(error ? { error } : {}),
          },
        ],
        ...(error ? { error } : {}),
      })
    } catch (cleanupError) {
      results.push({
        taskId,
        workspacePath: task.workspacePath,
        targetCount: 0,
        cleanableCount: 0,
        skippedCount: 0,
        errorCount: 1,
        bytes: 0,
        items: [],
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    }
  }
  const sum = (key: string) =>
    results.reduce((total, result) => total + Number(result[key] ?? 0), 0)
  return {
    success: results.every(result => Number(result.errorCount ?? 0) === 0),
    deleted: deleteTargets,
    taskCount: results.length,
    targetCount: sum('targetCount'),
    cleanableCount: sum('cleanableCount'),
    skippedCount: sum('skippedCount'),
    errorCount: sum('errorCount'),
    bytes: sum('bytes'),
    results,
  }
}

export async function archiveMatchingTasks(
  this: GatewayRuntimeCore,
  predicate: (task: GatewayTask) => boolean
) {
  const candidates = [...this.tasks.values()].filter(task => !task.ephemeral && predicate(task))
  const results: Array<Record<string, unknown>> = []
  let acceptedCount = 0
  for (const task of candidates) {
    try {
      const result = (await this.archiveTask({ taskId: task.taskId })) as Record<string, unknown>
      results.push(result)
      acceptedCount += 1
    } catch (error) {
      results.push({
        accepted: false,
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    accepted: acceptedCount === candidates.length,
    requestedCount: candidates.length,
    acceptedCount,
    results,
  }
}

export async function archiveProjectTasks(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  await this.hydrateAllPersistedTasks()
  const projectKey = text(params.runtimeProjectKey)
  const serverId = serverIdFromRuntimeProjectKey(projectKey) ?? text(params.deviceId)
  const workspacePath = text(params.workspacePath)
  if (!serverId && !workspacePath) throw new Error('归档项目缺少 KCoder 服务器或工作区')
  return this.archiveMatchingTasks(
    task =>
      (!serverId || task.serverId === serverId) &&
      (!workspacePath || sameWorkspacePath(task.workspacePath, workspacePath))
  )
}

export async function archiveAllTasks(this: GatewayRuntimeCore) {
  await this.hydrateAllPersistedTasks()
  return this.archiveMatchingTasks(() => true)
}
