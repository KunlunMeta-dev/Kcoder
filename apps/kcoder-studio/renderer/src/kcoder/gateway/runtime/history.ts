import { toolObservationOutput } from '../../toolObservationOutput'
import i18n from '@/i18n'
import {
  isPersistedKCoderAttachmentBlock,
  parsePersistedKCoderAttachmentBlocks,
  parsePersistedKCoderUserMessage,
  visibleRuntimeUserMessage,
} from '@/lib/runtime-user-message'
import { sameWorkspacePath, workspacePathKey } from '@/lib/workspace-path-identity'
import { decodeProviderFailure } from '@wegent/chat-core'
import { GatewayRpcError, safeGatewayFailureDiagnostic, type GatewayServer } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { requestTranscriptPage } from '../../gatewayTranscriptPage'
import { threadModelSelectionMode } from '../../modelSelectionMode'
import {
  parseThreadRunSummary,
  threadRunActivity,
  transcriptSnapshotRunning,
} from '../../threadRunSummary'
import { scanWorkspaces } from '../../workspaceScan'
import {
  authoritativeThreadMetadata,
  metadataTimestamp,
  PERSISTED_THREAD_MISS_THRESHOLD,
  record,
  runtimeTaskId,
  taskParent,
  text,
  type GatewayTask,
  type GatewayWorkspaceDescriptor,
} from './contracts'
import type { GatewayRuntimeCore } from './core'

export async function searchTasks(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const query = (text(params.query) ?? '').toLocaleLowerCase()
  if (!query) return { items: [] }
  await this.hydrateAllPersistedTasks()
  const limitValue = typeof params.limit === 'number' ? Math.trunc(params.limit) : 20
  const limit = Math.min(Math.max(limitValue, 1), 100)
  const servers = new Map((await this.servers()).map(server => [server.id, server]))
  const requestedDeviceId = text(params.deviceId)
  const requestedWorkspace = text(params.workspacePath)
  const candidates = [
    ...this.tasks.values(),
    ...(params.includeArchived === true ? this.archivedTasks.values() : []),
  ]
    .filter(task => !task.ephemeral)
    .filter(task => !requestedDeviceId || task.serverId === requestedDeviceId)
    .filter(
      task => !requestedWorkspace || sameWorkspacePath(task.workspacePath, requestedWorkspace)
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const items: Array<Record<string, unknown>> = []
  const clients = new Map<string, GatewayClient>()
  try {
    for (const task of candidates) {
      if (items.length >= limit) break
      const titleMatch = task.title.toLocaleLowerCase().indexOf(query)
      let snippet = titleMatch >= 0 ? task.title : null
      let matchStart = titleMatch
      let transcriptMatch: Awaited<ReturnType<GatewayRuntimeCore['searchTaskTranscript']>> = null
      if (snippet === null) {
        try {
          const server = servers.get(task.serverId)
          if (!server) continue
          const clientKey = `${task.serverId}\0${workspacePathKey(task.workspacePath)}`
          let client = clients.get(clientKey)
          if (!client) {
            client = await this.connectClient(server, 'runtime', task.workspacePath)
            clients.set(clientKey, client)
          }
          transcriptMatch = await this.searchTaskTranscript(client, task, query)
          if (!transcriptMatch) continue
          snippet = transcriptMatch.snippet
          matchStart = transcriptMatch.matchStart
        } catch (error) {
          console.warn(
            `[KCoder] 无法搜索任务 当前任务 的 transcript`,
            safeGatewayFailureDiagnostic(error)
          )
          continue
        }
      }
      items.push({
        address: {
          deviceId: task.serverId,
          taskId: task.taskId,
          threadId: task.threadId,
          workspacePath: task.workspacePath,
        },
        runtime: task.runtime,
        title: task.title,
        snippet,
        matchStart,
        matchEnd: matchStart + query.length,
        ...(transcriptMatch
          ? {
              messageId: transcriptMatch.messageId,
              messageRole: transcriptMatch.messageRole,
              messageCreatedAt: transcriptMatch.messageCreatedAt,
            }
          : {}),
        updatedAt: new Date(task.updatedAt).toISOString(),
        deviceName: servers.get(task.serverId)?.label ?? task.serverId,
        workspacePath: task.workspacePath,
        archived: this.archivedTasks.has(task.taskId),
        project: null,
      })
    }
  } finally {
    for (const client of clients.values()) client.close()
  }
  return { success: true, items }
}

export async function searchTaskTranscript(
  this: GatewayRuntimeCore,
  client: GatewayClient,
  task: GatewayTask,
  query: string
): Promise<{
  snippet: string
  matchStart: number
  messageId: string | null
  messageRole: string | null
  messageCreatedAt: string | null
} | null> {
  let beforeCursor: string | null = null
  let pages = 0
  const transcriptMessages: Array<Record<string, unknown>> = []
  // A cursor can be invalidated between two pages (compaction or rollback).
  // The server answers TRANSCRIPT_CURSOR_STALE (-32041), and the only safe
  // recovery is to restart from an authoritative cursor-less snapshot: pages
  // are never reordered or merged by timestamp.
  let restartAllowed = true
  for (;;) {
    let requestedCursor: string | null = beforeCursor
    try {
      do {
        requestedCursor = beforeCursor
        const result: {
          messages?: Array<Record<string, unknown>>
          hasMoreBefore?: boolean
          beforeCursor?: string | null
        } = await client.request('thread/read', {
          threadId: task.threadId,
          limit: 100,
          ...(beforeCursor ? { beforeCursor } : {}),
        })
        const messages = Array.isArray(result.messages) ? result.messages : []
        transcriptMessages.unshift(...messages)
        pages += 1
        beforeCursor = result.hasMoreBefore === true ? text(result.beforeCursor) : null
      } while (beforeCursor && pages < 5)
      break
    } catch (error) {
      if (
        !restartAllowed ||
        !requestedCursor ||
        !(error instanceof GatewayRpcError && error.code === -32041)
      )
        throw error
      // Exactly one restart: a cursor that keeps going stale must surface
      // instead of spinning.
      restartAllowed = false
      beforeCursor = null
      pages = 0
      transcriptMessages.length = 0
    }
  }
  for (const rawMessage of transcriptMessages) {
    const rawContent = text(record(rawMessage).content) ?? ''
    const content =
      text(record(rawMessage).role) === 'user' ? visibleRuntimeUserMessage(rawContent) : rawContent
    const found = content.toLocaleLowerCase().indexOf(query)
    if (found < 0) continue
    const start = Math.max(0, found - 60)
    const end = Math.min(content.length, found + query.length + 100)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < content.length ? '…' : ''
    return {
      snippet: `${prefix}${content.slice(start, end)}${suffix}`,
      matchStart: prefix.length + found - start,
      messageId: text(record(rawMessage).id),
      messageRole: text(record(rawMessage).role),
      messageCreatedAt:
        typeof record(rawMessage).timestampMs === 'number'
          ? new Date(Number(record(rawMessage).timestampMs)).toISOString()
          : null,
    }
  }
  return null
}

export async function hydrateAllPersistedTasks(this: GatewayRuntimeCore): Promise<void> {
  const servers = await this.servers()
  await this.hydratePersistedTasks(await this.workspaceDescriptors(servers, await this.server()))
  await this.hydrateArchivedWorktreeTasks(servers)
}

export async function managedWorktrees(
  this: GatewayRuntimeCore,
  server: GatewayServer
): Promise<Array<Record<string, unknown>>> {
  const client = await this.commandClient(server)
  const result = await client.request<{ items?: Array<Record<string, unknown>> }>(
    'runtime.worktrees.list',
    { deviceId: server.id }
  )
  return Array.isArray(result.items) ? result.items.map(record) : []
}

export async function hydrateArchivedWorktreeTasks(
  this: GatewayRuntimeCore,
  servers: GatewayServer[]
): Promise<void> {
  for (const server of servers) {
    let worktrees: Array<Record<string, unknown>>
    try {
      worktrees = await this.managedWorktrees(server)
    } catch (error) {
      if (!this.disposed) {
        console.warn(`[KCoder] 无法读取 目标 的工作树归档索引`, safeGatewayFailureDiagnostic(error))
      }
      continue
    }
    for (const worktree of worktrees) {
      const conversations = Array.isArray(worktree.conversations)
        ? worktree.conversations.map(record)
        : []
      for (const conversation of conversations) {
        const threadId = text(conversation.threadId)
        const taskId =
          text(conversation.taskId) ?? (threadId ? runtimeTaskId(server, threadId) : null)
        const workspacePath =
          text(conversation.workspacePath) ?? text(worktree.path) ?? server.workspacePath
        if (!threadId || !taskId || !workspacePath || this.tasks.has(taskId)) continue
        const now = Date.now()
        const createdAt = Number(conversation.createdAt)
        const updatedAt = Number(conversation.updatedAt)
        const task: GatewayTask = {
          serverId: server.id,
          taskId,
          threadId,
          workspacePath,
          ...(text(conversation.projectKey) ? { projectKey: text(conversation.projectKey)! } : {}),
          ...(text(conversation.projectName)
            ? { projectName: text(conversation.projectName)! }
            : {}),
          title: text(conversation.title) ?? `KCoder 会话 ${threadId.slice(0, 8)}`,
          runtime: 'kcoder',
          ...(text(conversation.model) ? { model: text(conversation.model)! } : {}),
          persisted: true,
          running: false,
          createdAt: Number.isFinite(createdAt) ? createdAt : now,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
          runtimeHandle: { threadId },
        }
        this.archivedTasks.set(taskId, task)
        this.threadByTask.set(taskId, threadId)
        this.taskByThread.set(this.threadKey(server.id, threadId), taskId)
      }
    }
  }
}

export async function restoreArchivedTaskWorkspace(
  this: GatewayRuntimeCore,
  task: GatewayTask
): Promise<void> {
  const server = (await this.servers()).find(item => item.id === task.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
  const worktree = (await this.managedWorktrees(server)).find(item =>
    sameWorkspacePath(text(item.path), task.workspacePath)
  )
  if (!worktree || worktree.state === 'active') return
  if (worktree.state !== 'restorable') {
    throw new Error(`任务工作树不可恢复：${task.workspacePath}`)
  }
  const revision = Number(worktree.revision)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`任务工作树缺少有效版本：${task.workspacePath}`)
  }
  const client = await this.commandClient(server)
  await client.request('runtime.worktrees.restore', {
    deviceId: server.id,
    path: task.workspacePath,
    expectedRevision: revision,
  })
}

export async function removeArchivedWorktreeConversation(
  this: GatewayRuntimeCore,
  task: GatewayTask
): Promise<void> {
  const server = (await this.servers()).find(item => item.id === task.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
  const worktree = (await this.managedWorktrees(server)).find(item =>
    sameWorkspacePath(text(item.path), task.workspacePath)
  )
  if (!worktree) return
  const client = await this.commandClient(server)
  await client.request('runtime.worktrees.conversations.remove', {
    deviceId: server.id,
    path: task.workspacePath,
    taskId: task.taskId,
  })
}

export function worktreeConversationReferences(
  this: GatewayRuntimeCore,
  serverId: string,
  workspacePath: string
): Array<Record<string, unknown>> {
  const conversations = new Map<string, GatewayTask>()
  for (const task of [...this.tasks.values(), ...this.archivedTasks.values()]) {
    if (task.serverId === serverId && sameWorkspacePath(task.workspacePath, workspacePath)) {
      conversations.set(task.taskId, task)
    }
  }
  return [...conversations.values()].map(task => ({
    deviceId: task.serverId,
    taskId: task.taskId,
    threadId: task.threadId,
    workspacePath: task.workspacePath,
    title: task.title,
    model: task.model ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }))
}

export async function linkManagedWorktreeConversation(
  this: GatewayRuntimeCore,
  server: GatewayServer,
  task: GatewayTask
): Promise<void> {
  if (sameWorkspacePath(task.workspacePath, server.workspacePath)) return
  const worktree = (await this.managedWorktrees(server)).find(item =>
    sameWorkspacePath(text(item.path), task.workspacePath)
  )
  if (!worktree) return
  const client = await this.commandClient(server)
  await client.request('runtime.worktrees.conversations.link', {
    deviceId: server.id,
    path: task.workspacePath,
    conversation: {
      deviceId: task.serverId,
      taskId: task.taskId,
      threadId: task.threadId,
      workspacePath: task.workspacePath,
      ...(task.projectKey ? { projectKey: task.projectKey } : {}),
      ...(task.projectName ? { projectName: task.projectName } : {}),
      title: task.title,
      model: task.model ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
  })
}

export async function hydratePersistedTasks(
  this: GatewayRuntimeCore,
  workspaces: GatewayWorkspaceDescriptor[],
  scanCancelled: () => boolean = () => false
): Promise<void> {
  const generation = this.workspaceScanGeneration
  const cancelled = () =>
    this.disposed || generation !== this.workspaceScanGeneration || scanCancelled()
  const ordered = [...workspaces].sort((a, b) => Number(b.projectActive) - Number(a.projectActive))
  await scanWorkspaces(
    ordered,
    async workspace => {
      workspace.threadsComplete = false
      workspace.threadListIssueCount = 1
      workspace.threadListSyncFailed = false
      if (!workspace.available || workspace.server.status === 'offline') return
      const { server, workspacePath } = workspace
      try {
        await this.withWorkspaceOperation(server.id, workspacePath, () =>
          cancelled()
            ? Promise.resolve()
            : this.withTransientClient(
                server,
                async client => {
                  if (client.supportsThreadResume?.() !== true) return
                  const persistedThreads: Array<Record<string, unknown>> = []
                  const allowPartial =
                    client.supportsExperimental?.('threadListCompleteness') === true
                  let threadsComplete = true
                  const archiveModes: Array<boolean | undefined> = [undefined]
                  for (const archived of archiveModes) {
                    let cursor: string | null = null
                    let snapshotMetadata:
                      { completeness: 'complete' | 'partial'; issueCount: number } | undefined
                    const seenCursors = new Set<string>()
                    do {
                      const result = await client.request<{
                        threads?: Array<Record<string, unknown>>
                        nextCursor?: string | null
                        completeness?: 'complete' | 'partial'
                        issueCount?: number
                      }>('thread/list', {
                        limit: 100,
                        ...(allowPartial ? { allowPartial: true } : {}),
                        ...(archived === undefined ? {} : { archived }),
                        ...(cursor ? { cursor } : {}),
                      })
                      if (cancelled()) return
                      if (!Array.isArray(result.threads)) {
                        throw new Error('运行目标返回了无效的 thread/list 结果')
                      }
                      if (
                        allowPartial &&
                        (!['complete', 'partial'].includes(result.completeness ?? '') ||
                          !Number.isSafeInteger(result.issueCount) ||
                          result.issueCount! < 0 ||
                          (result.completeness === 'complete' && result.issueCount !== 0))
                      )
                        throw new Error('运行目标返回了无效的 thread/list 完整性状态')
                      if (allowPartial) {
                        if (
                          snapshotMetadata &&
                          (snapshotMetadata.completeness !== result.completeness ||
                            snapshotMetadata.issueCount !== result.issueCount)
                        )
                          throw new Error('运行目标的 thread/list 快照完整性在分页期间发生变化')
                        snapshotMetadata ??= {
                          completeness: result.completeness!,
                          issueCount: result.issueCount!,
                        }
                      }
                      threadsComplete = result.completeness !== 'partial'
                      workspace.threadListIssueCount = result.issueCount ?? 0
                      persistedThreads.push(...result.threads)
                      const nextCursor = text(result.nextCursor)
                      if (!nextCursor) {
                        cursor = null
                        break
                      }
                      if (seenCursors.has(nextCursor)) {
                        throw new Error('运行目标返回了重复的 thread/list cursor')
                      }
                      seenCursors.add(nextCursor)
                      cursor = nextCursor
                    } while (persistedThreads.length <= 10_000)
                    if (cursor) throw new Error('运行目标的持久任务数量超过 10000')
                  }
                  const seenThreadKeys = new Set<string>()
                  workspace.threadsComplete = threadsComplete
                  for (const value of persistedThreads) {
                    const thread = record(value)
                    const threadId = text(thread.id)
                    const threadKey = threadId ? this.threadKey(server.id, threadId) : null
                    if (!threadId || !threadKey) continue
                    seenThreadKeys.add(threadKey)
                    this.persistedThreadMisses.delete(threadKey)
                    const now = Date.now()
                    const updatedAt = Number(thread.updatedAt ?? thread.updated_at)
                    const createdAt = Number(thread.createdAt ?? thread.created_at)
                    const localMetadata = this.taskMetadata.get(threadKey)
                    const serverMetadata = authoritativeThreadMetadata(thread.metadata)
                    const model = serverMetadata
                      ? (serverMetadata.model ?? undefined)
                      : (text(thread.model) ?? localMetadata?.model)
                    const archivedAt = serverMetadata
                      ? metadataTimestamp(serverMetadata.archivedAt)
                      : (metadataTimestamp(thread.archivedAt) ?? localMetadata?.archivedAt)
                    const parent = serverMetadata
                      ? (serverMetadata.parent ?? undefined)
                      : (taskParent(thread.parent) ?? localMetadata?.parent)
                    if (localMetadata?.deletedAt) {
                      this.archivedTasks.delete(runtimeTaskId(server, threadId))
                      continue
                    }
                    const existingTaskId = this.taskByThread.get(threadKey)
                    const existing = existingTaskId ? this.tasks.get(existingTaskId) : undefined
                    if (existing && !existing.persisted) continue
                    const syntheticTaskId = runtimeTaskId(server, threadId)
                    let taskId = existingTaskId ?? syntheticTaskId
                    if (!existingTaskId && this.tasks.has(taskId)) {
                      let suffix = 2
                      while (this.tasks.has(`${syntheticTaskId}:${suffix}`)) suffix += 1
                      taskId = `${syntheticTaskId}:${suffix}`
                    }
                    const hydratedTask: GatewayTask = {
                      scheduled: existing?.scheduled,
                      serverId: server.id,
                      taskId,
                      threadId,
                      workspacePath: sameWorkspacePath(text(thread.cwd), workspacePath)
                        ? workspacePath
                        : (text(thread.cwd) ?? workspacePath),
                      projectKey: workspace.projectKey,
                      projectName: workspace.projectName,
                      title:
                        (serverMetadata
                          ? (serverMetadata.title ?? undefined)
                          : (text(thread.title) ?? localMetadata?.title)) ??
                        `KCoder 会话 ${threadId.slice(0, 8)}`,
                      runtime: 'kcoder',
                      ...(model ? { model } : {}),
                      modelSelectionMode: threadModelSelectionMode(thread),
                      ...(parent ? { parent } : {}),
                      persisted: true,
                      // The coarse status cannot express a pending approval, background
                      // work or pending delivery; the shared derivation keeps every
                      // surface on the same authoritative facts.
                      running: this.compatibility.hydratedRunning(
                        thread.status,
                        existingTaskId ? this.activeTurnByTask.has(existingTaskId) : false
                      ),
                      runSummary: parseThreadRunSummary(thread.runSummary),
                      runActivity: threadRunActivity(
                        thread.status,
                        parseThreadRunSummary(thread.runSummary)
                      ),
                      createdAt:
                        localMetadata?.createdAt ?? (Number.isFinite(createdAt) ? createdAt : now),
                      updatedAt:
                        (serverMetadata ? undefined : localMetadata?.updatedAt) ??
                        (Number.isFinite(updatedAt) ? updatedAt : now),
                      runtimeHandle: { threadId },
                    }
                    this.threadByTask.set(taskId, threadId)
                    this.taskByThread.set(threadKey, taskId)
                    if (archivedAt) {
                      this.tasks.delete(taskId)
                      this.archivedTasks.set(taskId, { ...hydratedTask, running: false })
                    } else {
                      this.archivedTasks.delete(taskId)
                      this.tasks.set(taskId, hydratedTask)
                    }
                  }
                  if (!threadsComplete) return
                  for (const task of this.tasks.values()) {
                    const threadKey = this.threadKey(server.id, task.threadId)
                    if (
                      task.serverId !== server.id ||
                      !sameWorkspacePath(task.workspacePath, workspacePath) ||
                      !task.persisted ||
                      task.ephemeral ||
                      seenThreadKeys.has(threadKey)
                    )
                      continue
                    if (this.activeTurnByTask.has(task.taskId)) {
                      this.persistedThreadMisses.delete(threadKey)
                      continue
                    }
                    const misses = (this.persistedThreadMisses.get(threadKey) ?? 0) + 1
                    this.persistedThreadMisses.set(threadKey, misses)
                    if (misses < PERSISTED_THREAD_MISS_THRESHOLD) continue
                    this.tasks.delete(task.taskId)
                    this.threadByTask.delete(task.taskId)
                    this.taskByThread.delete(threadKey)
                    this.persistedThreadMisses.delete(threadKey)
                  }
                  for (const task of this.archivedTasks.values()) {
                    if (
                      task.serverId === server.id &&
                      sameWorkspacePath(task.workspacePath, workspacePath) &&
                      task.persisted &&
                      !seenThreadKeys.has(this.threadKey(server.id, task.threadId))
                    ) {
                      this.archivedTasks.delete(task.taskId)
                      this.threadByTask.delete(task.taskId)
                      this.taskByThread.delete(this.threadKey(server.id, task.threadId))
                    }
                  }
                },
                workspacePath
              )
        )
      } catch (error) {
        if (cancelled()) return
        // One unavailable target must not hide tasks from the remaining gateway servers.
        workspace.threadsComplete = false
        workspace.threadListIssueCount = Math.max(1, workspace.threadListIssueCount ?? 0)
        workspace.threadListSyncFailed = true
        console.warn(`[KCoder] 无法同步 目标 的持久任务`, safeGatewayFailureDiagnostic(error))
      }
    },
    cancelled
  )
}

export async function loadTaskTranscript(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const address = record(params.address)
  const requestedTaskId = text(params.taskId) ?? text(address.taskId)
  const taskId = this.resolveTaskId(requestedTaskId)
  let task = taskId ? (this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)) : undefined
  if (!task && this.compatibility.isRuntimeTaskId(requestedTaskId)) {
    await this.hydrateAllPersistedTasks()
    const hydratedTaskId = this.resolveTaskId(requestedTaskId) ?? ''
    task = this.tasks.get(hydratedTaskId) ?? this.archivedTasks.get(hydratedTaskId)
  }
  const threadId = task?.threadId ?? text(params.threadId) ?? text(address.threadId)
  if (!task && requestedTaskId && !this.compatibility.isRuntimeTaskId(requestedTaskId)) {
    return {
      taskId: requestedTaskId,
      messages: [],
      fullContent: true,
      rangeStart: 0,
      rangeEnd: 0,
      hasMoreBefore: false,
      beforeCursor: null,
      hasMoreAfter: false,
      afterCursor: null,
    }
  }
  if (!taskId || !threadId || !task) throw new Error('任务地址不存在或尚未恢复')
  let loadedTask = task
  const server = (await this.servers()).find(item => item.id === loadedTask.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${loadedTask.serverId}`)
  if (this.archivedTasks.has(taskId)) await this.restoreArchivedTaskWorkspace(loadedTask)
  const borrowedClient = loadedTask.ephemeral === true
  const client = borrowedClient
    ? this.clientByTask.get(taskId)
    : await this.connectClient(server, 'runtime', loadedTask.workspacePath)
  if (!client) throw new Error('临时会话连接已结束')
  if (!borrowedClient && client.supportsThreadResume?.() !== true) {
    client.close()
    throw new Error('KCoder app-server 不支持历史会话读取')
  }
  type ThreadReadResult = {
    thread?: Record<string, unknown>
    historyReset?: boolean
    messages?: Array<Record<string, unknown>>
    rangeStart?: number
    rangeEnd?: number
    hasMoreBefore?: boolean
    beforeCursor?: string | null
  }
  const readParams = {
    threadId,
    limit: Math.trunc(Math.min(Math.max(Number(params.limit) || 50, 1), 100)),
    ...(text(params.beforeCursor) ? { beforeCursor: text(params.beforeCursor) } : {}),
  }
  let result: ThreadReadResult | undefined
  let readSucceeded = false
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        result = await requestTranscriptPage<ThreadReadResult>(client, readParams)
        readSucceeded = true
        break
      } catch (error) {
        const newlyStartedPersistenceRace =
          loadedTask.persisted === false &&
          error instanceof Error &&
          error.message.toLowerCase().includes('persisted thread not found')
        if (!newlyStartedPersistenceRace) throw error
        if (attempt < 3) {
          await new Promise(resolveDelay => window.setTimeout(resolveDelay, 40 * (attempt + 1)))
        }
      }
    }
  } finally {
    if (!borrowedClient) client.close()
  }
  // thread/start returns the canonical id before the first history snapshot is guaranteed to be
  // visible. The active stream already owns the optimistic/seeded messages, so an empty page is
  // safer than emitting a false transcript failure after the bounded persistence retry.
  result ??= {
    messages: [],
    rangeStart: 0,
    rangeEnd: 0,
    hasMoreBefore: false,
    beforeCursor: null,
  }
  if (readSucceeded && loadedTask.persisted === false) {
    loadedTask = { ...loadedTask, persisted: true }
    this.tasks.set(taskId, loadedTask)
  }
  const rangeStart = Number.isFinite(result.rangeStart) ? Number(result.rangeStart) : 0
  const messages = Array.isArray(result.messages)
    ? result.messages.flatMap((value, index) => {
        const message = record(value)
        const id = text(message.id)
        const role = text(message.role)
        const rawContent = typeof message.content === 'string' ? message.content : ''
        const persistedUserMessage =
          role === 'user'
            ? parsePersistedKCoderUserMessage(rawContent)
            : { content: rawContent, attachments: [], clientMessageId: undefined }
        const structuredAttachments =
          role === 'user' ? parsePersistedKCoderAttachmentBlocks(message.blocks) : []
        const persistedAttachments =
          structuredAttachments.length > 0
            ? structuredAttachments
            : persistedUserMessage.attachments
        const content = persistedUserMessage.content
        const blocks = Array.isArray(message.blocks)
          ? message.blocks
              .filter(value => !isPersistedKCoderAttachmentBlock(value))
              .map(value => {
                const rawBlock = record(value)
                const hasImages =
                  Array.isArray(rawBlock.outputImages) || rawBlock.outputImagesOmitted === true
                const block = { ...rawBlock }
                if (hasImages) {
                  block.tool_output = toolObservationOutput({
                    ...rawBlock,
                    output: rawBlock.tool_output ?? rawBlock.toolOutput,
                  })
                  delete block.toolOutput
                  delete block.outputImages
                  delete block.outputImagesOmitted
                }
                const blockId = text(block.id) ?? text(block.tool_use_id)
                const interrupted = blockId
                  ? this.interruptedBackgroundToolByKey.get(`${taskId}\0${blockId}`)
                  : undefined
                const missingResult = block.recovery_reason === 'result_unavailable'
                const recoveredBlock = interrupted
                  ? {
                      ...block,
                      status: 'error',
                      tool_output: interrupted.output,
                      toolOutput: interrupted.output,
                    }
                  : missingResult
                    ? {
                        ...block,
                        tool_output: i18n.t('common:runtimeRecovery.toolResultUnavailable'),
                      }
                    : block
                if (text(recoveredBlock.type) !== 'file_changes') {
                  return interrupted || missingResult || hasImages ? recoveredBlock : value
                }
                const fileChanges = record(
                  recoveredBlock.fileChanges ?? recoveredBlock.file_changes
                )
                if (!text(fileChanges.artifact_id)) {
                  return interrupted || missingResult || hasImages ? recoveredBlock : value
                }
                const normalized = { ...fileChanges, device_id: loadedTask.serverId }
                return {
                  ...recoveredBlock,
                  fileChanges: normalized,
                  file_changes: normalized,
                }
              })
          : []
        if (
          !id ||
          !role ||
          (!content &&
            blocks.length === 0 &&
            persistedAttachments.length === 0 &&
            !['cancelled', 'failed'].includes(text(message.status) ?? ''))
        )
          return []
        const timestamp = Number(message.timestampMs)
        const validTimestamp =
          Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= 8_640_000_000_000_000
        return [
          {
            id,
            ...(persistedUserMessage.clientMessageId
              ? { clientMessageId: persistedUserMessage.clientMessageId }
              : text(message.clientMessageId)
                ? { clientMessageId: text(message.clientMessageId) }
                : {}),
            ...(text(message.turnId) ? { turnId: text(message.turnId) } : {}),
            role,
            content,
            ...(persistedAttachments.length > 0
              ? {
                  attachments: persistedAttachments.map((attachment, attachmentIndex) => ({
                    id: -((rangeStart + index + 1) * 1_000 + attachmentIndex + 1),
                    filename: attachment.filename,
                    file_size: attachment.fileSize,
                    mime_type: attachment.mimeType,
                    status: 'ready',
                    file_extension: attachment.filename.includes('.')
                      ? `.${attachment.filename.split('.').at(-1)}`
                      : '',
                    created_at: new Date(validTimestamp ? timestamp : Date.now()).toISOString(),
                    local_path: attachment.path,
                    local_preview_url: attachment.path,
                    runtime_device_id: loadedTask.serverId,
                    runtime_thread_id: threadId,
                    runtime_workspace_path: loadedTask.workspacePath,
                  })),
                }
              : {}),
            ...(blocks.length > 0 ? { blocks } : {}),
            contentTruncated: message.contentTruncated === true,
            contentOriginalChars:
              typeof message.contentOriginalChars === 'number'
                ? message.contentOriginalChars
                : undefined,
            messageIndex: rangeStart + index,
            subtaskId: `${threadId}:history:${rangeStart + index}`,
            status: text(message.status) || 'done',
            ...(text(message.error) ? { error: text(message.error) } : {}),
            ...(text(message.errorType) ? { errorType: text(message.errorType) } : {}),
            attemptId: text(message.attemptId) ?? undefined,
            continuedByAttemptId: text(message.continuedByAttemptId) ?? undefined,
            providerFailure: decodeProviderFailure(
              message.providerFailure ?? message.provider_failure
            ),
            createdAt: new Date(validTimestamp ? timestamp : Date.now()).toISOString(),
          },
        ]
      })
    : []
  return {
    taskId,
    workspacePath: loadedTask.workspacePath,
    runtime: loadedTask.runtime,
    running: transcriptSnapshotRunning(result.thread, loadedTask.running),
    title: loadedTask.title,
    messages,
    fullContent:
      result.hasMoreBefore !== true && !messages.some(message => message.contentTruncated === true),
    historyReset: result.historyReset === true,
    rangeStart,
    rangeEnd: Number.isFinite(result.rangeEnd)
      ? Number(result.rangeEnd)
      : rangeStart + messages.length,
    hasMoreBefore: result.hasMoreBefore === true,
    beforeCursor: text(result.beforeCursor),
    hasMoreAfter: false,
    afterCursor: null,
  }
}
