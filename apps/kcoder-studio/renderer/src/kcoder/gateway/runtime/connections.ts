import { sameWorkspacePath, workspacePathKey } from '@/lib/workspace-path-identity'
import { type GatewayServer, safeGatewayFailureDiagnostic } from '../../gatewayRpc'
import { clearLegacyKCoderContext, readLegacyKCoderContext } from '../../gatewayRuntimeSettings'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import { scanWorkspaces } from '../../workspaceScan'
import { WorkspaceScanCancelledError } from '../../workspaceScanError'
import {
  EXECUTOR_EVENT,
  type GatewayWorkspaceDescriptor,
  record,
  runtimeProjectKey,
  SELECTED_SERVER_KEY,
  serverIdFromRuntimeProjectKey,
  type SharedRuntimeContext,
  TASK_METADATA_KEY,
  text,
} from './contracts'
import type { GatewayRuntimeCore } from './core'

export function invalidateAccountTarget(this: GatewayRuntimeCore, targetId: string): void {
  this.accountEpochByTarget.set(targetId, {})
  const taskPrefix = `kcoder:${targetId}:`
  const taskIds = new Set(
    [...this.tasks.values(), ...this.archivedTasks.values()]
      .filter(task => task.serverId === targetId)
      .map(task => task.taskId)
  )
  for (const map of [
    this.tasks,
    this.archivedTasks,
    this.clientByTask,
    this.resumeClientByTask,
    this.disconnectRecoveryByTask,
    this.threadByTask,
    this.persistedThreadMisses,
    this.canonicalTaskByRequested,
    this.activeTurnByTask,
  ]) {
    for (const key of map.keys())
      if (key.startsWith(taskPrefix) || taskIds.has(key)) map.delete(key)
  }
  for (const map of [
    this.turnText,
    this.turnAttemptIds,
    this.toolNameByCall,
    this.interruptedBackgroundToolByKey,
  ]) {
    for (const key of map.keys()) if (key.startsWith(taskPrefix)) map.delete(key)
  }
  for (const [key, pending] of this.pendingQuestionByKey) {
    if (!key.startsWith(taskPrefix)) continue
    if (pending.autoResolutionTimer) window.clearTimeout(pending.autoResolutionTimer)
    this.pendingQuestionByKey.delete(key)
  }
  for (const [agentId, job] of this.backgroundJobById) {
    if (job.serverId === targetId) this.backgroundJobById.delete(agentId, job)
  }
  for (const key of this.taskMetadata.keys()) {
    if (key.startsWith(`${targetId}\0`)) this.taskMetadata.delete(key)
  }
  try {
    localStorage.setItem(TASK_METADATA_KEY, JSON.stringify(Object.fromEntries(this.taskMetadata)))
  } catch {
    /* Storage can be unavailable. */
  }
  for (const key of this.taskByThread.keys())
    if (key.startsWith(`${targetId}\0`)) this.taskByThread.delete(key)
  for (const key of this.completedTurnKeys)
    if (key.startsWith(taskPrefix)) this.completedTurnKeys.delete(key)
  for (const key of this.pendingTurnStartByTask)
    if (key.startsWith(taskPrefix)) this.pendingTurnStartByTask.delete(key)
  this.remoteSessions.invalidateTarget(targetId)
  void this.browserRuntime.invalidateTarget(targetId)
  for (const [client, owner] of this.accountClients) {
    if (owner === targetId) {
      client.close()
      this.accountClients.delete(client)
    }
  }
  void emit(EXECUTOR_EVENT, {
    event: 'executor.account_context_invalidated',
    payload: { deviceId: targetId },
  })
  window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId } }))
}

export function trackAsyncJob(this: GatewayRuntimeCore, job: Promise<unknown>): void {
  const settled = job.then(
    () => undefined,
    () => undefined
  )
  this.pendingAsyncJobs.add(settled)
  void settled.then(() => this.pendingAsyncJobs.delete(settled))
}

export function servers(this: GatewayRuntimeCore): Promise<GatewayServer[]> {
  const pending = (this.serversPromise ??= this.loadServers())
  return pending.then(servers => {
    if (this.serversPromise !== pending) throw new WorkspaceScanCancelledError()
    return servers
  })
}

export async function server(this: GatewayRuntimeCore): Promise<GatewayServer> {
  if (this.selectedServer) return this.selectedServer
  const servers = await this.servers()
  const selectedId = localStorage.getItem(SELECTED_SERVER_KEY)
  this.selectedServer = servers.find(server => server.id === selectedId) ?? servers[0]
  localStorage.setItem(SELECTED_SERVER_KEY, this.selectedServer.id)
  return this.selectedServer
}

export async function sharedRuntimeContext(
  this: GatewayRuntimeCore,
  client: GatewayClient
): Promise<SharedRuntimeContext> {
  let context = await client.request<SharedRuntimeContext>('runtime.context.get', {})
  const legacy = readLegacyKCoderContext()
  const patch: Record<string, unknown> = {}
  if (!context.instructionsConfigured && legacy.instructions !== null) {
    patch.instructions = legacy.instructions
  }
  if (
    !context.personalityConfigured &&
    (legacy.personality === 'friendly' || legacy.personality === 'pragmatic')
  ) {
    patch.personality = legacy.personality
  }
  if (Object.keys(patch).length > 0) {
    context = await client.request<SharedRuntimeContext>('runtime.context.update', {
      ...patch,
      onlyIfUnconfigured: true,
    })
  }
  clearLegacyKCoderContext()
  return context
}

export async function serverForParams(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
): Promise<GatewayServer> {
  const executionRequest = record(params.executionRequest)
  const execution = record(params.execution)
  const projectKey = text(params.runtimeProjectKey) ?? text(executionRequest.runtime_project_key)
  const requestedIds = [
    serverIdFromRuntimeProjectKey(projectKey),
    text(params.deviceId),
    text(params.device_id),
    text(execution.deviceId),
    text(execution.device_id),
  ].filter((value): value is string => Boolean(value))
  const uniqueRequestedIds = [...new Set(requestedIds)]
  if (uniqueRequestedIds.length > 1) {
    throw new Error(`KCoder 服务器选择冲突：${uniqueRequestedIds.join(', ')}`)
  }
  const requestedServerId = uniqueRequestedIds[0] ?? null
  const workspacePath =
    text(params.workspacePath) ??
    text(executionRequest.project_workspace_path) ??
    text(params.path) ??
    text(params.cwd)
  const servers = await this.servers()
  if (requestedServerId) {
    const explicit = servers.find(server => server.id === requestedServerId)
    if (!explicit) throw new Error(`未知的 KCoder 服务器：${requestedServerId}`)
    return explicit
  }
  if (workspacePath) {
    const matches = servers.filter(server => sameWorkspacePath(server.workspacePath, workspacePath))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new Error(`工作区路径对应多个 KCoder 服务器：${workspacePath}`)
  }
  return this.server()
}

export async function connectClient(
  this: GatewayRuntimeCore,
  server: GatewayServer,
  channel: 'runtime' | 'browser' = 'runtime',
  workspacePath?: string,
  restartProbe = false,
  onCreated?: (client: GatewayClient) => void
): Promise<GatewayClient> {
  if (this.isRestartingServer(server.id) && !restartProbe) {
    throw new Error('KCoder app-server restart is in progress')
  }
  const epoch = this.accountEpochByTarget.get(server.id) ?? {}
  this.accountEpochByTarget.set(server.id, epoch)
  const valid = () => this.accountEpochByTarget.get(server.id) === epoch
  const client = this.createClient(server.id, this.token, channel, workspacePath)
  this.accountClients.set(client, server.id)
  client.addEventListener('close', () => this.accountClients.delete(client), { once: true })
  const originalRequest = client.request.bind(client)
  client.request = async <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<T> => {
    if (!valid()) throw new WorkspaceScanCancelledError()
    const result = options
      ? await originalRequest<T>(method, params, options)
      : await originalRequest<T>(method, params)
    if (!valid()) throw new WorkspaceScanCancelledError()
    return result
  }

  onCreated?.(client)
  // app-server JSON-RPC notifications are wire-ordered. Project them serially so
  // rapid item/delta and turn/completed events cannot finish asynchronous emission in reverse and lose final text.
  this.notificationQueueByClient.set(client, Promise.resolve())
  client.addEventListener('close', () => this.toolPathPreviews.disconnect(client), { once: true })
  client.addEventListener('notification', event => {
    if (this.disposed || !valid()) return
    const message = (event as CustomEvent<{ method?: string; params?: Record<string, unknown> }>)
      .detail
    if (message.method) {
      const diagnosticConnection = client.diagnosticConnection
      if (message.method === 'server/disconnected') {
        this.appServerDisconnectedClients.add(client)
        this.toolPathPreviews.disconnect(client)
      }
      const notificationQueue = (this.notificationQueueByClient.get(client) ?? Promise.resolve())
        .then(() =>
          valid()
            ? this.forwardNotification(
                message.method!,
                message.params ?? {},
                server.id,
                client,
                diagnosticConnection
              )
            : undefined
        )
        .catch(error => {
          if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
          console.error(
            '[KCoder] Failed to forward app-server notification',
            safeGatewayFailureDiagnostic(error)
          )
        })
      this.notificationQueueByClient.set(client, notificationQueue)
      this.trackAsyncJob(notificationQueue)
    }
  })
  client.addEventListener('request', event => {
    const message = (
      event as CustomEvent<{
        id?: number
        method?: string
        params?: Record<string, unknown>
      }>
    ).detail
    const forwarding = (this.notificationQueueByClient.get(client) ?? Promise.resolve())
      .then(() => (valid() ? this.forwardServerRequest(client, message, server.id) : undefined))
      .catch(error => {
        if (typeof message.id === 'number') {
          client.respondError?.(
            message.id,
            -32603,
            error instanceof Error ? error.message : String(error)
          )
        }
      })
    this.trackAsyncJob(forwarding)
  })
  try {
    const ready = client.connect()
    if (channel === 'runtime') {
      this.ownedRuntimeClients.set(client, {
        client,
        server,
        workspacePath: workspacePath ?? server.workspacePath,
        ready,
      })
      client.addEventListener('close', () => this.ownedRuntimeClients.delete(client), {
        once: true,
      })
    }
    await ready
    if (this.disposed || !valid()) {
      client.close()
      throw new Error('KCoder 网关运行时已关闭')
    }
    return client
  } catch (error) {
    this.ownedRuntimeClients.delete(client)
    client.close()
    throw error
  }
}

export async function controlClient(this: GatewayRuntimeCore): Promise<GatewayClient> {
  if (!this.controlClientPromise) {
    const attempt = this.server().then(async server => {
      const client = await this.connectClient(server)
      client.addEventListener(
        'close',
        () => {
          if (this.controlClientPromise === attempt) this.controlClientPromise = null
        },
        { once: true }
      )
      return client
    })
    this.controlClientPromise = attempt
    void attempt.catch(() => {
      if (this.controlClientPromise === attempt) this.controlClientPromise = null
    })
  }
  return this.controlClientPromise
}

export async function commandClient(
  this: GatewayRuntimeCore,
  server: GatewayServer,
  workspacePath?: string
): Promise<GatewayClient> {
  if (this.isRestartingServer(server.id))
    throw new Error('KCoder app-server restart is in progress')
  const effectiveWorkspacePath = this.compatibility.commandWorkspace(
    workspacePath,
    server.workspacePath
  )
  const clientKey = `${server.id}\0${workspacePathKey(effectiveWorkspacePath)}`
  const existing = this.commandClientByServer.get(clientKey)
  if (existing) return existing
  const attempt = this.connectClient(server, 'runtime', effectiveWorkspacePath).then(client => {
    client.addEventListener(
      'close',
      () => this.handleCommandClientClose(clientKey, server.id, client, attempt),
      { once: true }
    )
    return client
  })
  this.commandClientByServer.set(clientKey, attempt)
  void attempt.catch(() => {
    if (this.commandClientByServer.get(clientKey) === attempt) {
      this.commandClientByServer.delete(clientKey)
    }
  })
  return attempt
}

export async function closeCachedCommandClient(
  this: GatewayRuntimeCore,
  server: GatewayServer,
  workspacePath: string
) {
  const clientKey = `${server.id}\0${workspacePathKey(workspacePath)}`
  const pending = this.commandClientByServer.get(clientKey)
  if (!pending) return
  this.commandClientByServer.delete(clientKey)
  const client = await pending.catch(() => null)
  client?.close()
}

export function handleCommandClientClose(
  this: GatewayRuntimeCore,
  clientKey: string,
  serverId: string,
  client: GatewayClient,
  attempt: Promise<GatewayClient>
) {
  if (this.commandClientByServer.get(clientKey) === attempt) {
    this.commandClientByServer.delete(clientKey)
  }
  this.remoteSessions.handleCommandClientClose(serverId, client)
}

export async function withTransientClient<T>(
  this: GatewayRuntimeCore,
  server: GatewayServer,
  operation: (client: GatewayClient) => Promise<T>,
  workspacePath?: string
): Promise<T> {
  const generation = this.workspaceScanGeneration
  const client = await this.connectClient(server, 'runtime', workspacePath, false, created => {
    this.transientClients.add(created)
    created.addEventListener('close', () => this.transientClients.delete(created), { once: true })
  })
  try {
    if (this.disposed || generation !== this.workspaceScanGeneration) {
      throw new WorkspaceScanCancelledError()
    }
    return await operation(client)
  } finally {
    this.transientClients.delete(client)
    if (![...this.clientByTask.values()].includes(client)) client.close()
  }
}

export async function withWorkspaceOperation<T>(
  this: GatewayRuntimeCore,
  serverId: string,
  workspacePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${serverId}\0${workspacePathKey(workspacePath)}`
  const previous = this.workspaceOperationByKey.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  this.workspaceOperationByKey.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (this.workspaceOperationByKey.get(key) === tail) {
      this.workspaceOperationByKey.delete(key)
    }
  }
}

export async function workspaceDescriptors(
  this: GatewayRuntimeCore,
  servers: GatewayServer[],
  selectedServer: GatewayServer,
  scanCancelled: () => boolean = () => false
): Promise<GatewayWorkspaceDescriptor[]> {
  const generation = this.workspaceScanGeneration
  const cancelled = () =>
    this.disposed || generation !== this.workspaceScanGeneration || scanCancelled()
  const descriptors = new Map<string, GatewayWorkspaceDescriptor[]>()
  const ordered = [...servers].sort(
    (a, b) => Number(b.id === selectedServer.id) - Number(a.id === selectedServer.id)
  )
  await scanWorkspaces(
    ordered,
    async server => {
      const basePath = server.workspacePath ?? `/remote/${server.id}`
      const byPath = new Map<string, GatewayWorkspaceDescriptor>()
      byPath.set(workspacePathKey(basePath), {
        server,
        workspacePath: basePath,
        workspaceKind: 'workspace',
        label: server.label,
        labelKey: server.labelKey,
        projectName: server.label,
        projectKey: runtimeProjectKey(server.id),
        projectRoots: [basePath],
        projectPinned: true,
        projectActive: server.id === selectedServer.id,
        pinnedTaskIds: [],
        available: true,
      })
      const healthStartedAt = Date.now()
      try {
        await this.withTransientClient(server, async client => {
          let rootProjectPinned = true
          if (client.supportsExperimental?.('workspaceRegistry') !== false) {
            const listed = await client.request<{
              items?: Array<Record<string, unknown>>
              pinnedTaskIds?: unknown[]
              rootProjectPinned?: boolean
            }>('runtime.workspaces.list', { deviceId: server.id })
            if (cancelled()) return
            const pinnedTaskIds = Array.isArray(listed.pinnedTaskIds)
              ? listed.pinnedTaskIds.filter(
                  (value): value is string => typeof value === 'string' && value.length > 0
                )
              : []
            rootProjectPinned = listed.rootProjectPinned !== false
            for (const descriptor of byPath.values()) {
              descriptor.pinnedTaskIds = pinnedTaskIds
              descriptor.projectPinned = rootProjectPinned
            }
            for (const rawItem of Array.isArray(listed.items) ? listed.items : []) {
              const item = record(rawItem)
              const workspacePath = text(item.workspacePath)
              if (!workspacePath) continue
              const rawRoots = Array.isArray(item.projectRoots) ? item.projectRoots : []
              const roots = rawRoots
                .map(value => (typeof value === 'string' ? value : null))
                .filter((value): value is string => Boolean(value))
              byPath.set(workspacePathKey(workspacePath), {
                server,
                workspacePath,
                workspaceKind: item.workspaceKind === 'worktree' ? 'worktree' : 'workspace',
                label:
                  text(item.label) ??
                  workspacePath.split('/').filter(Boolean).at(-1) ??
                  'Workspace',
                projectName:
                  text(item.projectName) ??
                  text(item.label) ??
                  workspacePath.split('/').filter(Boolean).at(-1) ??
                  'Workspace',
                projectKey: text(item.projectKey) ?? workspacePath,
                projectSource: 'local_project',
                ...(roots.length > 0 ? { projectRoots: roots } : {}),
                projectPinned: item.projectPinned === true,
                projectPinnedOrder:
                  typeof item.projectPinnedOrder === 'number' ? item.projectPinnedOrder : null,
                projectActive: item.projectActive === true,
                pinnedTaskIds,
                available: item.available !== false,
                ...(text(item.error) ? { error: text(item.error)! } : {}),
                ...(item.projectAppearance !== undefined
                  ? { projectAppearance: item.projectAppearance }
                  : {}),
              })
            }
          }
          const worktrees = await client.request<{
            items?: Array<Record<string, unknown>>
          }>('runtime.worktrees.list', { deviceId: server.id })
          if (cancelled()) return
          for (const rawItem of Array.isArray(worktrees.items) ? worktrees.items : []) {
            const item = record(rawItem)
            const workspacePath = text(item.path)
            if (!workspacePath || item.state !== 'active') continue
            byPath.set(workspacePathKey(workspacePath), {
              server,
              workspacePath,
              workspaceKind: 'worktree',
              worktreeId: text(item.worktreeId) ?? undefined,
              label: text(item.repositoryName) ?? text(item.worktreeId) ?? 'Worktree',
              projectName: server.label,
              projectKey: runtimeProjectKey(server.id),
              projectRoots: [basePath],
              projectPinned: rootProjectPinned,
              projectActive: false,
              pinnedTaskIds: byPath.get(workspacePathKey(basePath))?.pinnedTaskIds ?? [],
              available: true,
            })
          }
        })
        if (cancelled()) return
        server.status = 'online'
        server.latencyMs = Math.max(0, Date.now() - healthStartedAt)
        server.checkedAt = Date.now()
        delete server.error
        if (!cancelled()) this.workspaceDescriptorCache.set(server, [...byPath.values()])
      } catch (error) {
        if (cancelled()) return
        server.status = 'offline'
        server.latencyMs = Math.max(0, Date.now() - healthStartedAt)
        server.checkedAt = Date.now()
        server.error = error instanceof Error ? error.message : String(error)
        for (const previous of this.workspaceDescriptorCache.get(server) ?? []) {
          byPath.set(workspacePathKey(previous.workspacePath), {
            ...previous,
            server,
            available: false,
            error: server.error,
          })
        }
        console.warn(`[KCoder] 无法读取 目标 的工作区注册表`, safeGatewayFailureDiagnostic(error))
      }
      if (![...byPath.values()].some(item => item.projectActive)) {
        const base = byPath.get(workspacePathKey(basePath))
        if (base) base.projectActive = server.id === selectedServer.id
      }
      if (!cancelled()) descriptors.set(server.id, [...byPath.values()])
    },
    cancelled
  )
  return servers.flatMap(server => descriptors.get(server.id) ?? [])
}
