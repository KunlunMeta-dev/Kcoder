import { computerUseConsent } from '../../computerUseConsent'
import { computerUseTurnParams } from '../../gatewayComputerUse'
import { createRandomUuid } from '@/lib/random-id'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { negotiateModelSelector } from '../../../../../shared/modelSelection'
import {
  executionReasoningEffort,
  executionSelectedModel,
  executionServiceTier,
} from '../../executionParameters'
import { turnModeParams } from '../../gatewayExecutionModes'
import { messagePrompt, messageTitle } from '../../gatewayMessageInput'
import { GatewayRpcError, safeGatewayFailureDiagnostic, type GatewayServer } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import { isTemporaryTaskCreate, startTaskThread } from '../../gatewayTemporaryThread'
import { turnPermissionParams } from '../../gatewayTurnPermissions'
import { startTurnWithReceipt, TurnAcceptanceUnknownError } from '../../gatewayTurnReceipt'
import { modelSelectionModeParams } from '../../modelSelectionMode'
import { EXECUTOR_EVENT, record, runtimeTaskId, text, type GatewayTask } from './contracts'
import type { GatewayRuntimeCore } from './core'

export async function disposeTemporaryTask(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const address = record(params.address)
  const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
  const task = taskId ? this.tasks.get(taskId) : undefined
  if (!task || !taskId) return { disposed: false }
  if (!task.ephemeral) throw new Error('只能关闭临时会话，不能删除普通会话')
  const client = this.clientByTask.get(taskId)
  if (!client) throw new Error('临时会话的连接已丢失，请重新连接运行目标')
  // Preserve ownership and turn mappings until disposal is acknowledged.
  const result = await client.request('thread/dispose', { threadId: task.threadId })
  this.toolPathPreviews.clearTask(taskId)
  this.activeTurnByTask.get(taskId)?.complete()
  this.clientByTask.delete(taskId)
  this.tasks.delete(taskId)
  this.threadByTask.delete(taskId)
  this.taskByThread.delete(this.threadKey(task.serverId, task.threadId))
  this.activeTurnByTask.delete(taskId)
  for (const [alias, canonical] of this.canonicalTaskByRequested) {
    if (canonical === taskId) this.canonicalTaskByRequested.delete(alias)
  }
  client.close()
  return result
}

export async function createTask(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  server: GatewayServer,
  assertScope: () => Promise<void> = async () => {}
) {
  const ephemeral = isTemporaryTaskCreate(params)
  const execution = record(params.executionRequest)
  const clientMessageId = text(params.clientMessageId) ?? text(execution.clientMessageId)
  const reasoningEffort = executionReasoningEffort(execution)
  const proxyUrl = this.compatibility.executionProxyUrl(execution)
  const serviceTier = executionServiceTier(execution)
  const modelSelection = record(params.modelSelection)
  const selectionMode = params.modelSelectionMode ?? execution.modelSelectionMode
  let selectedModel =
    executionSelectedModel(execution, modelSelection) ?? text(modelSelection.providerId)
  const requestedTaskId = text(params.taskId) ?? text(execution.task_id) ?? createRandomUuid()
  if (this.compatibility.isRuntimeTaskId(requestedTaskId)) {
    throw new Error('任务 ID 使用了运行目标保留命名空间')
  }
  const rawPrompt = messagePrompt(execution, params.message)
  if (this.canonicalTaskByRequested.has(requestedTaskId)) {
    throw new Error(`任务已存在：${requestedTaskId}`)
  }
  // The gateway reuses one resident-thread app-server connection per workspace while
  // each task retains independent client ownership for precise notification,
  // approval/question, and terminal-resource routing.
  const workspacePath = text(params.workspacePath) ?? server.workspacePath ?? '/'
  let client = await this.connectClient(server, 'runtime', workspacePath)
  let prompt: string
  let started: { thread?: { id?: string } } | undefined
  try {
    await assertScope()
    modelSelectionModeParams(selectionMode, client, selectedModel ?? undefined)
    selectedModel = (await negotiateModelSelector(client, selectedModel)) ?? null
    const sharedContext = await this.sharedRuntimeContext(client)
    prompt = await this.remoteSessions.promptWithAttachmentsForClient(
      rawPrompt,
      execution,
      server,
      client,
      sharedContext
    )
    await assertScope()
    started = await startTaskThread(client, {
      serverId: server.id,
      workspacePath,
      params,
      model: selectedModel,
      creationRequestId: requestedTaskId,
      recoverClient: async () => {
        await assertScope()
        const recovered = await this.connectClient(server, 'runtime', workspacePath)
        try {
          await assertScope()
          return recovered
        } catch (error) {
          recovered.close()
          throw error
        }
      },
      onRecoveredClient: recovered => {
        if (client !== recovered) client.close()
        client = recovered
      },
    })
    await assertScope()
  } catch (error) {
    if (started?.thread?.id) {
      try {
        await client.request(ephemeral ? 'thread/dispose' : 'thread/delete', {
          threadId: started.thread.id,
        })
      } catch {
        /* No turn was submitted; do not recover into another account. */
      }
    }
    client.close()
    throw error
  }
  const threadId = text(started?.thread?.id)
  if (!threadId) {
    client.close()
    throw new Error('KCoder app-server 未返回 thread id')
  }
  const deleteEmptyThread = async () => {
    try {
      await client.request(ephemeral ? 'thread/dispose' : 'thread/delete', { threadId })
    } catch {
      // Preserve the original creation error; deletion only reclaims a resident thread whose turn never started successfully.
    }
  }
  // The app-server thread id is the only task identity that survives a renderer reload. Return
  // and route this deterministic id from the first response so a deep link does not change after
  // hydration reconstructs the task from persisted history.
  const taskId = runtimeTaskId(server, threadId)
  if (this.tasks.has(taskId)) {
    await deleteEmptyThread()
    client.close()
    throw new Error(`任务已存在：${taskId}`)
  }
  this.canonicalTaskByRequested.set(requestedTaskId, taskId)
  this.threadByTask.set(taskId, threadId)
  this.taskByThread.set(this.threadKey(server.id, threadId), taskId)
  this.bindTaskClient(taskId, client)
  const now = Date.now()
  const createdTask: GatewayTask = {
    ...(ephemeral ? { ephemeral: true } : {}),
    serverId: server.id,
    taskId,
    threadId,
    workspacePath,
    ...(text(params.runtimeProjectKey) ? { projectKey: text(params.runtimeProjectKey)! } : {}),
    ...(text(params.runtimeProjectName) ? { projectName: text(params.runtimeProjectName)! } : {}),
    title: text(params.title) ?? messageTitle(execution, rawPrompt),
    runtime: 'kcoder',
    ...modelSelectionModeParams(selectionMode, client, selectedModel ?? undefined),
    ...(selectedModel ? { model: selectedModel } : {}),
    persisted: false,
    running: true,
    createdAt: now,
    updatedAt: now,
    runtimeHandle: { threadId },
  }
  this.tasks.set(taskId, createdTask)
  try {
    await assertScope()
    await this.updateTaskMetadata(
      createdTask,
      {
        title: createdTask.title,
        ...(selectedModel ? { model: selectedModel } : {}),
      },
      {
        title: createdTask.title,
        ...(selectedModel ? { model: selectedModel } : {}),
        createdAt: now,
        updatedAt: now,
      }
    )
    // An initial goal must exist in the engine before it builds the first model
    // request. A renderer-only goal seed is not an active persistent goal.
    if (params.initialGoal != null) {
      await this.setTaskGoal({ ...record(params.initialGoal), taskId })
    }
    if (!ephemeral) await this.linkManagedWorktreeConversation(server, createdTask)
  } catch (error) {
    this.tasks.delete(taskId)
    this.canonicalTaskByRequested.delete(requestedTaskId)
    this.threadByTask.delete(taskId)
    this.taskByThread.delete(this.threadKey(server.id, threadId))
    this.clientByTask.delete(taskId)
    await deleteEmptyThread()
    client.close()
    throw error
  }
  this.pendingTurnStartByTask.add(taskId)
  let turnStartAttempted = false
  try {
    await assertScope()
    turnStartAttempted = true
    const submitted = await startTurnWithReceipt(
      client,
      {
        ...turnModeParams(params, client),
        ...computerUseTurnParams(params, client, server),
        ...modelSelectionModeParams(selectionMode, client, selectedModel ?? undefined),
        threadId,
        input: [{ type: 'text', text: prompt }],
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(proxyUrl !== null ? { proxyUrl } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...turnPermissionParams(execution, client),
      },
      async () => {
        await assertScope()
        const recovered = await this.readyTaskClient(createdTask)
        await assertScope()
        return recovered
      }
    )
    await assertScope()
    const turn = submitted.result
    const turnId = text(turn.turn?.id)
    if (!turnId) throw new Error('KCoder app-server 未返回 turn id')
    if (params.computerUse) computerUseConsent.set(server.id, taskId, true)
    this.pendingTurnStartByTask.delete(taskId)
    const terminalReceipt = submitted.recovered && turn.turn?.status !== 'running'
    if (terminalReceipt) {
      const current = this.tasks.get(taskId) ?? createdTask
      this.tasks.set(taskId, { ...current, persisted: true, running: false, updatedAt: Date.now() })
    }
    if (!this.completedTurnKeys.delete(`${taskId}:${turnId}`) && !terminalReceipt) {
      this.trackActiveTurn(taskId, turnId)
    }
  } catch (error) {
    this.pendingTurnStartByTask.delete(taskId)
    try {
      await assertScope()
    } catch (scopeError) {
      if (!turnStartAttempted) await deleteEmptyThread()
      // A submitted/uncertain old-account turn is not a new-account failure.
      // Do not reconnect, replay its prompt, or emit its data into the new scope.
      throw scopeError
    }
    if (error instanceof TurnAcceptanceUnknownError) {
      // Preserve the discoverable thread and the caller's draft. Unknown acceptance
      // is not a model failure and cannot safely trigger automatic re-submission.
      const current = this.tasks.get(taskId) ?? createdTask
      this.tasks.set(taskId, { ...current, persisted: true, updatedAt: Date.now() })
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    this.tasks.set(taskId, {
      ...createdTask,
      persisted: true,
      running: false,
      updatedAt: Date.now(),
    })
    const failedTurnId = `turn-start-failed-${createRandomUuid()}`
    await emit(EXECUTOR_EVENT, {
      event: 'response.created',
      payload: { taskId, subtaskId: failedTurnId, deviceId: server.id, data: {} },
    }).catch(emitError =>
      console.warn('[KCoder] 无法创建首轮失败投影', safeGatewayFailureDiagnostic(emitError))
    )
    await emit(EXECUTOR_EVENT, {
      event: 'response.failed',
      payload: {
        taskId,
        subtaskId: failedTurnId,
        deviceId: server.id,
        ...(error instanceof GatewayRpcError &&
        record(error.data).error_type === 'local_runtime_error'
          ? { type: 'local_runtime_error' }
          : {}),
        data: { message, retryable: true },
      },
    }).catch(emitError =>
      console.warn('[KCoder] 无法报告首轮发送失败', safeGatewayFailureDiagnostic(emitError))
    )
  }
  return {
    accepted: true,
    deviceId: server.id,
    taskId,
    workspacePath,
    runtime: 'kcoder',
    runtimeHandle: { threadId },
  }
}

export async function forkTaskAtTurn(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const source = record(params.source)
  const sourceTaskId = this.resolveTaskId(text(params.taskId) ?? text(source.taskId))
  const lastTurnId = text(params.lastTurnId) ?? text(params.last_turn_id)
  if (!sourceTaskId || !lastTurnId) {
    return {
      accepted: false,
      success: false,
      runtime: 'kcoder',
      source,
      target: record(params.target),
      error: '分叉任务缺少源任务或 lastTurnId',
      code: 'bad_request',
    }
  }
  let task = this.tasks.get(sourceTaskId)
  if (!task) {
    await this.hydrateAllPersistedTasks()
    task = this.tasks.get(sourceTaskId)
  }
  if (!task) {
    return {
      accepted: false,
      success: false,
      runtime: 'kcoder',
      source,
      target: record(params.target),
      error: '源任务不存在或尚未恢复',
      code: 'task_not_found',
    }
  }
  const target = record(params.target)
  const targetDeviceId = text(target.deviceId) ?? task.serverId
  const targetWorkspacePath = text(target.workspacePath) ?? task.workspacePath
  if (
    targetDeviceId !== task.serverId ||
    !sameWorkspacePath(targetWorkspacePath, task.workspacePath)
  ) {
    return {
      accepted: false,
      success: false,
      runtime: 'kcoder',
      source: { deviceId: task.serverId, taskId: task.taskId },
      target,
      error: '按回合分叉必须保留在源 KCoder 服务器和工作区；跨服务器请新建任务',
      code: 'cross_device_fork_unsupported',
    }
  }
  const server = (await this.servers()).find(item => item.id === task.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
  const sourceClient = this.clientByTask.get(task.taskId) ?? (await this.resumeTask(task))
  try {
    const forked = await sourceClient.request<{ thread?: { id?: string } }>('thread/fork', {
      threadId: task.threadId,
      lastTurnId,
      cwd: task.workspacePath,
      excludeTurns: true,
    })
    const threadId = text(forked.thread?.id)
    if (!threadId) throw new Error('KCoder app-server 未返回分叉 thread id')
    const taskId = runtimeTaskId(server, threadId)
    const deleteUnownedFork = () =>
      sourceClient
        .request('thread/delete', { threadId })
        .catch(deleteError =>
          console.warn(
            '[KCoder] 无法清理恢复失败后的分叉 thread',
            safeGatewayFailureDiagnostic(deleteError)
          )
        )
    let client: GatewayClient
    try {
      client = await this.connectClient(server, 'runtime', task.workspacePath)
    } catch (error) {
      await deleteUnownedFork()
      throw error
    }
    try {
      await client.request('thread/resume', { threadId })
    } catch (error) {
      client.close()
      await deleteUnownedFork()
      throw error
    }
    const now = Date.now()
    const parent = { taskId: task.taskId, threadId: task.threadId, lastTurnId }
    const forkTask: GatewayTask = {
      serverId: server.id,
      taskId,
      threadId,
      workspacePath: task.workspacePath,
      ...(task.projectKey ? { projectKey: task.projectKey } : {}),
      ...(task.projectName ? { projectName: task.projectName } : {}),
      title: text(params.title) ?? task.title,
      runtime: 'kcoder',
      ...(task.model ? { model: task.model } : {}),
      persisted: true,
      running: false,
      createdAt: now,
      updatedAt: now,
      runtimeHandle: { threadId },
      parent,
    }
    this.tasks.set(taskId, forkTask)
    this.threadByTask.set(taskId, threadId)
    this.taskByThread.set(this.threadKey(server.id, threadId), taskId)
    this.bindTaskClient(taskId, client)
    try {
      await this.updateTaskMetadata(
        forkTask,
        {
          title: forkTask.title,
          ...(forkTask.model ? { model: forkTask.model } : {}),
          parent,
        },
        {
          title: forkTask.title,
          ...(forkTask.model ? { model: forkTask.model } : {}),
          parent,
          updatedAt: now,
        }
      )
    } catch (error) {
      this.tasks.delete(taskId)
      this.threadByTask.delete(taskId)
      this.taskByThread.delete(this.threadKey(server.id, threadId))
      this.clientByTask.delete(taskId)
      await client
        .request('thread/delete', { threadId })
        .catch(deleteError =>
          console.warn(
            '[KCoder] 无法清理分叉失败后的 thread',
            safeGatewayFailureDiagnostic(deleteError)
          )
        )
      client.close()
      throw error
    }
    return {
      success: true,
      accepted: true,
      source: { deviceId: task.serverId, taskId: task.taskId },
      target: {
        deviceId: server.id,
        taskId,
        threadId,
        workspacePath: task.workspacePath,
        runtimeHandle: { threadId },
      },
      runtime: 'kcoder',
    }
  } catch (error) {
    return {
      success: false,
      accepted: false,
      source: { deviceId: task.serverId, taskId: task.taskId },
      target: { deviceId: server.id, workspacePath: task.workspacePath },
      runtime: 'kcoder',
      error: error instanceof Error ? error.message : String(error),
      code: 'fork_failed',
    }
  }
}
