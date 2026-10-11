import { computerUseConsent } from '../../computerUseConsent'
import { computerUseTurnParams } from '../../gatewayComputerUse'
import i18n from '@/i18n'
import { createRandomUuid } from '@/lib/random-id'
import { agentConnection, readAgentArtifact } from './agentRequests'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { negotiateModelSelector } from '../../../../../shared/modelSelection'
import {
  executionReasoningEffort,
  executionSelectedModel,
  executionServiceTier,
} from '../../executionParameters'
import { turnModeParams } from '../../gatewayExecutionModes'
import { messagePrompt } from '../../gatewayMessageInput'
import { GatewayRpcError, type GatewayServer, safeGatewayFailureDiagnostic } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import { turnPermissionParams } from '../../gatewayTurnPermissions'
import { startTurnWithReceipt, TurnAcceptanceUnknownError } from '../../gatewayTurnReceipt'
import { modelSelectionModeParams } from '../../modelSelectionMode'
import {
  type ActiveGatewayTurn,
  EXECUTOR_EVENT,
  type GatewayTask,
  isRetryableReadonlyTaskConnectionError,
  record,
  text,
} from './contracts'
import type { GatewayRuntimeCore } from './core'

export async function sendTask(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  server: GatewayServer,
  interruptFirst: boolean
) {
  const address = record(params.address)
  const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
  const threadId = (taskId && this.threadByTask.get(taskId)) ?? text(address.threadId)
  const questionResponse = record(
    params.requestUserInputResponse ?? params.request_user_input_response
  )
  if (Object.keys(questionResponse).length > 0) {
    return this.respondToTaskQuestion(taskId, questionResponse)
  }
  const execution = record(params.executionRequest)
  const clientMessageId = text(params.clientMessageId) ?? text(execution.clientMessageId)
  if (!taskId || !threadId) throw new Error('任务地址或消息不完整')
  const retryFromTurnId = text(params.retryFromTurnId)
  const retryFromAttemptId = text(params.retryFromAttemptId)
  const retryCurrentConfiguration = params.retryModelConfiguration === 'current'
  const rawPrompt = retryFromTurnId ? '' : messagePrompt(execution, params.message)
  const task = this.tasks.get(taskId)
  const reasoningEffort = executionReasoningEffort(execution)
  const proxyUrl = this.compatibility.executionProxyUrl(execution)
  const serviceTier = executionServiceTier(execution)
  const explicitModel =
    executionSelectedModel(execution, record(params.modelSelection)) ??
    text(record(params.modelSelection).providerId)
  if (!task) throw new Error('任务连接已失效，请重新打开或恢复任务')
  let client = await this.readyTaskClient(task)
  if (retryCurrentConfiguration && (!retryFromTurnId || !retryFromAttemptId || !explicitModel)) {
    throw new Error(i18n.t('workbench.failed_turn_current_identity_required'))
  }
  if (retryCurrentConfiguration && !client.supportsExperimental?.('retryModelConfigurationV1')) {
    throw new Error(i18n.t('workbench.failed_turn_current_unsupported'))
  }

  let modelSelectionMode =
    params.modelSelectionMode ??
    execution.modelSelectionMode ??
    (!explicitModel && !retryFromTurnId ? task.modelSelectionMode : undefined)
  let requestedModel =
    retryFromTurnId && !explicitModel
      ? undefined
      : modelSelectionMode === 'follow_target_default'
        ? explicitModel
        : (explicitModel ?? task.model)
  let selectedModel = requestedModel
  modelSelectionModeParams(modelSelectionMode, client, selectedModel, retryFromTurnId)
  selectedModel = await negotiateModelSelector(client, selectedModel)
  if (interruptFirst) {
    const active = this.activeTurnByTask.get(taskId)
    if (active) {
      const result = await client.request<{ interrupted?: boolean }>('turn/interrupt', {
        threadId,
        turnId: active.turnId,
      })
      if (result.interrupted !== true) throw new Error('KCoder app-server 未能中断当前任务')
      await this.waitForTurnCompletion(active)
    }
  }
  const updatedAt = Date.now()
  if (!retryFromTurnId && task && selectedModel && selectedModel !== task.model) {
    await this.updateTaskMetadata(
      task,
      { model: selectedModel },
      {
        ...this.taskMetadata.get(this.threadKey(task.serverId, task.threadId)),
        model: selectedModel,
        updatedAt,
      }
    )
  }
  // Metadata writes may span a connection replacement; reacquire the client from the latest recovery generation before sending.
  client = await this.readyTaskClient(task)
  modelSelectionMode =
    params.modelSelectionMode ??
    execution.modelSelectionMode ??
    (!explicitModel && !retryFromTurnId ? task.modelSelectionMode : undefined)
  requestedModel =
    retryFromTurnId && !explicitModel
      ? undefined
      : modelSelectionMode === 'follow_target_default'
        ? explicitModel
        : (explicitModel ?? task.model)
  modelSelectionModeParams(modelSelectionMode, client, requestedModel, retryFromTurnId)
  selectedModel = await negotiateModelSelector(client, requestedModel)
  const sharedContext = retryFromTurnId ? null : await this.sharedRuntimeContext(client)
  if (
    retryFromTurnId &&
    (!client.supportsExperimental?.('failedTurnContinuationV1') ||
      !client.supportsExperimental?.('turnRetryOperationV1') ||
      (Boolean(retryFromAttemptId && retryFromAttemptId !== retryFromTurnId) &&
        !client.supportsExperimental?.('turnAttemptRetryV1')))
  ) {
    throw new Error(i18n.t('workbench.failed_turn_continuation_unsupported'))
  }
  const prompt = retryFromTurnId
    ? ''
    : await this.remoteSessions.promptWithAttachmentsForClient(
        rawPrompt,
        execution,
        server,
        client,
        sharedContext!,
        threadId
      )
  // A normal send in an approved session renews its turn-scoped lease. Do not
  // silently downgrade an approved desktop request to a plain model turn.
  const desktopParams = computerUseTurnParams(
    computerUseConsent.has(server.id, taskId)
      ? { ...params, computerUse: { approved: true, target: 'local_windows_desktop' } }
      : params,
    client,
    server,
    Boolean(retryFromTurnId),
    computerUseConsent.has(server.id, taskId),
    !params.computerUse && computerUseConsent.has(server.id, taskId)
  )
  let turnId: string
  let receiptStatus: string | undefined
  if (retryFromTurnId) this.completedTurnKeys.delete(`${taskId}:${retryFromTurnId}`)
  this.pendingTurnStartByTask.add(taskId)
  try {
    const submitted = await startTurnWithReceipt(
      client,
      {
        ...(retryFromTurnId
          ? {
              retryFromTurnId,
              // One recovery of one failed turn: any client that computes the
              // same name is answered with the attempt that already accepted it
              // instead of starting a second one (R054).
              ...(retryFromAttemptId && client.supportsExperimental?.('turnAttemptRetryV1')
                ? { retryFromAttemptId }
                : {}),
              retryOperationId: `retry:${threadId}:${retryFromAttemptId || retryFromTurnId}${retryCurrentConfiguration ? ':current' : ''}`,
              ...(retryCurrentConfiguration ? { retryModelConfiguration: 'current' } : {}),
            }
          : turnModeParams(params, client)),
        ...modelSelectionModeParams(modelSelectionMode, client, selectedModel, retryFromTurnId),
        threadId,
        input: retryFromTurnId ? [] : [{ type: 'text', text: prompt }],
        ...(!retryFromTurnId && clientMessageId ? { clientMessageId } : {}),
        ...(params.resubmit === true ? { resubmit: true } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(proxyUrl !== null ? { proxyUrl } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...turnPermissionParams(execution, client),
        ...desktopParams,
      },
      () => this.readyTaskClient(task)
    )
    client = submitted.client
    const turn = submitted.result
    if (submitted.recovered || turn.turn?.status !== 'running') receiptStatus = turn.turn?.status
    if (this.clientByTask.get(taskId) !== client || this.disconnectRecoveryByTask.has(taskId)) {
      throw new Error('消息发送期间任务连接再次中断，请重试')
    }
    const resolvedTurnId = text(turn.turn?.id)
    if (!resolvedTurnId) throw new Error('KCoder app-server 未返回 turn id')
    turnId = resolvedTurnId
    if (
      params.computerUse &&
      desktopParams.computerUse &&
      client.supportsExperimental?.('computerUseSessionAuthorizationV1') === true
    )
      computerUseConsent.set(server.id, taskId, true)
    const acceptedMode = modelSelectionModeParams(
      modelSelectionMode,
      client,
      selectedModel,
      retryFromTurnId
    ).modelSelectionMode
    if (acceptedMode) {
      task.modelSelectionMode = acceptedMode
      const currentTask = this.tasks.get(taskId)
      if (currentTask) this.tasks.set(taskId, { ...currentTask, modelSelectionMode: acceptedMode })
    } else if (explicitModel) {
      task.modelSelectionMode = 'explicit'
      const currentTask = this.tasks.get(taskId)
      if (currentTask) this.tasks.set(taskId, { ...currentTask, modelSelectionMode: 'explicit' })
    }
  } catch (error) {
    this.pendingTurnStartByTask.delete(taskId)
    if (error instanceof TurnAcceptanceUnknownError) throw error
    if (retryFromTurnId) {
      if (
        error instanceof GatewayRpcError &&
        error.code === -32602 &&
        error.message.includes('retry_model_incompatible:')
      ) {
        throw new Error(i18n.t('workbench.failed_turn_current_incompatible'), { cause: error })
      }
      if (error instanceof GatewayRpcError && error.code === -32046) {
        throw new Error(i18n.t('workbench.failed_turn_continuation_unavailable'), {
          cause: error,
        })
      }
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    this.tasks.set(taskId, { ...task, running: false, updatedAt: Date.now() })
    // After rejecting turn/start, the server emits neither turn/started nor
    // turn/completed. Project a terminal failure so the optimistically inserted
    // user message stops waiting and becomes retryable.
    const failedTurnId = `turn-start-failed-${createRandomUuid()}`
    await emit(EXECUTOR_EVENT, {
      event: 'response.created',
      payload: { taskId, subtaskId: failedTurnId, deviceId: task.serverId, data: {} },
    }).catch(emitError =>
      console.warn('[KCoder] 无法创建 turn/start 失败投影', safeGatewayFailureDiagnostic(emitError))
    )
    await emit(EXECUTOR_EVENT, {
      event: 'response.failed',
      payload: {
        taskId,
        subtaskId: failedTurnId,
        deviceId: task.serverId,
        ...(error instanceof GatewayRpcError &&
        record(error.data).error_type === 'local_runtime_error'
          ? { type: 'local_runtime_error' }
          : {}),
        data: { message, retryable: true },
      },
    }).catch(emitError =>
      console.warn('[KCoder] 无法报告 turn/start 失败', safeGatewayFailureDiagnostic(emitError))
    )
    throw error
  }
  this.pendingTurnStartByTask.delete(taskId)
  const completedBeforeAcknowledgement =
    this.completedTurnKeys.delete(`${taskId}:${turnId}`) ||
    (receiptStatus !== undefined && receiptStatus !== 'running')
  if (receiptStatus !== undefined) {
    const current = this.tasks.get(taskId)
    if (current)
      this.tasks.set(taskId, {
        ...current,
        running: receiptStatus === 'running',
        updatedAt: Date.now(),
      })
    window.dispatchEvent(
      new CustomEvent('kcoder:turn-receipt-reconciled', {
        detail: { taskId, deviceId: server.id },
      })
    )
  }
  if (!completedBeforeAcknowledgement) this.trackActiveTurn(taskId, turnId)
  if (task && !completedBeforeAcknowledgement) {
    this.tasks.set(taskId, {
      ...task,
      ...(selectedModel ? { model: selectedModel } : {}),
      running: true,
      updatedAt,
    })
  }
  return { accepted: true, deviceId: server.id, taskId }
}

export async function resumeTask(
  this: GatewayRuntimeCore,
  task: GatewayTask
): Promise<GatewayClient> {
  const existing = this.resumeClientByTask.get(task.taskId)
  if (existing) return existing
  const attempt = this.resumeTaskOnce(task)
  this.resumeClientByTask.set(task.taskId, attempt)
  void attempt
    .finally(() => {
      if (this.resumeClientByTask.get(task.taskId) === attempt) {
        this.resumeClientByTask.delete(task.taskId)
      }
    })
    .catch(() => undefined)
  return attempt
}

export async function readyTaskClient(
  this: GatewayRuntimeCore,
  task: GatewayTask
): Promise<GatewayClient> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (this.isRestartingServer(task.serverId))
      throw new Error('KCoder app-server restart is in progress')
    const recovery = this.disconnectRecoveryByTask.get(task.taskId)
    if (recovery) {
      await recovery
      continue
    }
    const client = this.clientByTask.get(task.taskId)
    if (client) {
      // Let the queued close handler install the next recovery generation before confirming that this connection can send.
      await Promise.resolve()
      if (
        this.clientByTask.get(task.taskId) === client &&
        !this.disconnectRecoveryByTask.has(task.taskId)
      ) {
        if (this.isRestartingServer(task.serverId))
          throw new Error('KCoder app-server restart is in progress')
        return client
      }
      continue
    }
    await this.resumeTask(task)
  }
  throw new Error('任务连接持续变化，无法安全发送请求')
}

export async function taskDescriptor(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const address = record(params.address)
  const requestedTaskId = text(params.taskId) ?? text(address.taskId)
  let taskId = this.resolveTaskId(requestedTaskId)
  let task = taskId ? this.tasks.get(taskId) : undefined
  if (!task && this.compatibility.isRuntimeTaskId(requestedTaskId)) {
    await this.hydrateAllPersistedTasks()
    taskId = this.resolveTaskId(requestedTaskId)
    task = taskId ? this.tasks.get(taskId) : undefined
  }
  if (!taskId || !task) throw new Error('任务地址不存在或尚未恢复')
  const server = (await this.servers()).find(item => item.id === task.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
  return { taskId, task, server }
}

export async function taskConnection(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task, server } = await this.taskDescriptor(params)
  const client = await this.readyTaskClient(task)
  return { taskId, task, server, client }
}

export async function compactTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task, client } = await this.taskConnection(params)
  if (this.activeTurnByTask.has(taskId)) throw new Error('任务运行中，暂时无法压缩上下文')
  await client.request('thread/compact', { threadId: task.threadId })
  this.tasks.set(taskId, { ...task, updatedAt: Date.now() })
  return { accepted: true, taskId }
}

export async function rollbackTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task, server, client } = await this.taskConnection(params)
  if (this.activeTurnByTask.has(taskId)) throw new Error('任务运行中，暂时无法编辑上一条消息')
  const result = await client.request<{ failedFiles?: number; removedMessages?: number }>(
    'thread/rollback',
    {
      threadId: task.threadId,
    }
  )
  if (Number(result.failedFiles ?? 0) > 0) {
    throw new Error(`回滚未完整恢复 ${result.failedFiles} 个文件，已停止提交替换消息`)
  }
  if (Number(result.removedMessages ?? 0) <= 0) {
    throw new Error('压缩后的上下文中已找不到上一条消息边界，无法安全提交替换消息')
  }
  return this.sendTask(params, server, false)
}

export async function revertTaskFileChanges(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const { task, client } = await this.taskConnection(params)
  const fileChanges = record(params.fileChanges ?? params.file_changes)
  const artifactId = text(fileChanges.artifact_id)
  if (!artifactId) throw new Error('文件变更缺少服务器 artifact id')
  const workspacePath = text(fileChanges.workspace_path) ?? task.workspacePath
  if (!sameWorkspacePath(workspacePath, task.workspacePath)) {
    throw new Error('文件变更所属工作区与任务不一致')
  }
  const result = await client.request<{
    success?: boolean
    stdout?: unknown
    stderr?: string
  }>('device/execute', {
    deviceId: task.serverId,
    command_key: 'turn_file_changes_revert',
    threadId: task.threadId,
    path: task.workspacePath,
    args: [artifactId],
    timeout_seconds: 30,
    max_output_bytes: 64 * 1024,
  })
  const stdout = record(result.stdout)
  const authoritative = record(stdout.file_changes)
  if (!text(authoritative.artifact_id)) {
    throw new Error(result.stderr || 'Git 无法安全回滚这组文件变更')
  }
  const reverted = { ...authoritative, device_id: task.serverId }
  return { fileChanges: reverted, file_changes: reverted }
}

export async function guideTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, server } = await this.taskConnection(params)
  const attachmentIds = Array.isArray(params.attachmentIds)
    ? params.attachmentIds
    : Array.isArray(params.attachment_ids)
      ? params.attachment_ids
      : []
  if (attachmentIds.length > 0 && !Array.isArray(params.attachments)) {
    throw new Error('KCoder 网关不支持仅使用云端 attachmentIds 的引导附件')
  }
  const rawMessage = text(params.message)
  if (!rawMessage) throw new Error('引导消息不能为空')
  const message = this.promptWithApplicationContext(
    rawMessage,
    params.additionalContext ?? params.additional_context
  )
  const response = await this.sendTask(
    {
      ...params,
      executionRequest: {
        prompt: message,
        ...(Array.isArray(params.attachments) ? { attachments: params.attachments } : {}),
      },
    },
    server,
    this.activeTurnByTask.has(taskId)
  )
  const turnId = this.activeTurnByTask.get(taskId)?.turnId
  const guidanceId =
    text(params.clientGuidanceId) ?? text(params.client_guidance_id) ?? createRandomUuid()
  await emit(EXECUTOR_EVENT, {
    event: 'response.guidance.applied',
    payload: {
      taskId,
      subtaskId: turnId,
      deviceId: server.id,
      data: { guidanceId, message: rawMessage, appliedAtMs: Date.now() },
    },
  })
  return { ...response, success: true, guidanceId, turnId }
}

export async function steerSubagent(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task, server, client, assertCurrent } = await agentConnection(this, params)
  if (client.supportsExperimental?.('agentSteering') !== true) {
    throw new Error('当前 KCoder app-server 不支持定向调整子智能体')
  }
  const agentId = text(params.agentId) ?? text(params.agent_id)
  const message = text(params.message)
  if (!agentId || !message) throw new Error('子智能体地址或调整消息不完整')
  if (new TextEncoder().encode(message).byteLength > 64 * 1024) {
    throw new Error('子智能体调整消息超过 64 KiB 限制')
  }
  const clientMessageId =
    text(params.clientMessageId) ?? text(params.client_message_id) ?? createRandomUuid()
  const result = await client.request<Record<string, unknown>>('agent/steer', {
    threadId: task.threadId,
    agentId,
    message,
    clientMessageId,
  })
  assertCurrent()
  const status = text(result.status) ?? 'rejected'
  const messageId = text(result.messageId)
  const accepted = result.queued === true || status === 'applied'
  await emit(EXECUTOR_EVENT, {
    event: 'response.subagent.activity',
    payload: {
      taskId,
      subtaskId: this.activeTurnByTask.get(taskId)?.turnId ?? task.threadId,
      deviceId: server.id,
      data: {
        agent_path: agentId,
        agent_id: agentId,
        kind: 'background',
        status: 'running',
        steer_status: status,
        message_id: messageId,
        client_message_id: clientMessageId,
        occurred_at_ms: Date.now(),
      },
    },
  })
  return {
    ...result,
    accepted,
    success: accepted,
    taskId,
    agentId,
    clientMessageId,
    ...(messageId ? { messageId } : {}),
  }
}

export async function readSubagentArtifact(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  return readAgentArtifact.call(this, params)
}

export function promptWithApplicationContext(
  this: GatewayRuntimeCore,
  message: string,
  rawContext: unknown
) {
  const entries = Object.entries(record(rawContext)).flatMap(([name, rawEntry]) => {
    const entry = record(rawEntry)
    return entry.kind === 'application' && typeof entry.value === 'string'
      ? [`[${name}]\n${entry.value}`]
      : []
  })
  return entries.length > 0
    ? `<application_context>\n${entries.join('\n\n')}\n</application_context>\n\n${message}`
    : message
}

export async function getTaskGoal(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const address = record(params.address)
  const requestedTaskId = text(params.taskId) ?? text(address.taskId)
  if (
    requestedTaskId &&
    !this.compatibility.isRuntimeTaskId(requestedTaskId) &&
    !this.canonicalTaskByRequested.has(requestedTaskId)
  ) {
    return { accepted: false, taskId: requestedTaskId, goal: null }
  }
  const retryDelays = [0, 75, 150, 300, 600]
  let lastError: unknown
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt] > 0) {
      await new Promise(resolve => window.setTimeout(resolve, retryDelays[attempt]))
    }
    try {
      const { taskId, task, server } = await this.taskDescriptor(params)
      const result = await this.withTransientClient(
        server,
        client =>
          client.request<{ goal?: Record<string, unknown> | null }>('thread/goal/get', {
            threadId: task.threadId,
          }),
        task.workspacePath
      )
      return { accepted: true, taskId, goal: result.goal ?? null }
    } catch (error) {
      if (!isRetryableReadonlyTaskConnectionError(error)) throw error
      lastError = error
    }
  }
  throw lastError
}

export async function setTaskGoal(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task, client } = await this.taskConnection(params)
  if (
    params.status === 'cancelled' &&
    client.supportsExperimental?.('goalCancellationV1') !== true
  ) {
    throw new Error(
      'Goal cancellation is unsupported by this server; update the remote KCoder server first.'
    )
  }
  const result = await client.request<{ goal?: Record<string, unknown> }>('thread/goal/set', {
    threadId: task.threadId,
    ...(typeof params.objective === 'string' ? { objective: params.objective } : {}),
    ...(typeof params.status === 'string' ? { status: params.status } : {}),
    ...(typeof params.mode === 'string' ? { mode: params.mode } : {}),
    ...(typeof params.verificationKind === 'string'
      ? { verificationKind: params.verificationKind }
      : {}),
    ...(typeof params.tokenBudget === 'number' ? { tokenBudget: params.tokenBudget } : {}),
    ...(params.tokenBudget === null ? { clearTokenBudget: true } : {}),
  })
  if (!result.goal) throw new Error('KCoder app-server 未返回 goal')
  return { accepted: true, taskId, goal: result.goal }
}

export async function clearTaskGoal(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { taskId, task, client } = await this.taskConnection(params)
  const result = await client.request<{ cleared?: boolean }>('thread/goal/clear', {
    threadId: task.threadId,
  })
  return { accepted: true, taskId, cleared: result.cleared === true }
}

export async function cancelTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const address = record(params.address)
  const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
  const threadId = (taskId && this.threadByTask.get(taskId)) ?? text(address.threadId)
  const client = taskId ? this.clientByTask.get(taskId) : undefined
  const active = taskId ? this.activeTurnByTask.get(taskId) : undefined
  if (!taskId || !threadId || !client || !active) {
    return { accepted: false, interrupted: false, taskId }
  }
  const result = await client.request<{ interrupted?: boolean }>('turn/interrupt', {
    threadId,
    turnId: active.turnId,
  })
  return {
    accepted: result.interrupted === true,
    interrupted: result.interrupted === true,
    taskId,
  }
}

export async function shortenWaitTask(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const address = record(params.address)
  const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
  const threadId = (taskId && this.threadByTask.get(taskId)) ?? text(address.threadId)
  const client = taskId ? this.clientByTask.get(taskId) : undefined
  const active = taskId ? this.activeTurnByTask.get(taskId) : undefined
  if (!taskId || !threadId || !client || !active) {
    return { accepted: false, shortened: false, taskId }
  }
  const result = await client.request<{ shortened?: boolean }>('turn/shorten_wait', {
    threadId,
    turnId: active.turnId,
  })
  return {
    accepted: true,
    shortened: result.shortened === true,
    taskId,
  }
}

export function trackActiveTurn(
  this: GatewayRuntimeCore,
  taskId: string,
  turnId: string,
  internal = false
) {
  let complete: () => void = () => {}
  const completion = new Promise<void>(resolve => {
    complete = resolve
  })
  this.activeTurnByTask.set(taskId, { turnId, internal, completion, complete })
}

export async function waitForTurnCompletion(this: GatewayRuntimeCore, active: ActiveGatewayTurn) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      active.completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('等待 KCoder app-server 中断任务超时')), 10_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
