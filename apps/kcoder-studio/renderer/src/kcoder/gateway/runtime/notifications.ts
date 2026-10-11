import { computerUseConsent } from '../../computerUseConsent'
import { notifyRuntimeWorkChanged } from '../../runtimeWorkEvents'
import { toolObservationOutput } from '../../toolObservationOutput'
import { computerUseStates } from '../../computerUseState'
import i18n from '@/i18n'
import { decodeProviderFailure } from '@wegent/chat-core'
import {
  reportBackgroundRunDiagnostic,
  type DiagnosticConnection,
} from '../../backgroundRunDiagnostic'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import {
  EXECUTOR_EVENT,
  finiteNumber,
  rawDeltaText,
  record,
  runtimeTaskId,
  text,
} from './contracts'
import type { GatewayRuntimeCore } from './core'

export async function forwardNotification(
  this: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>,
  sourceServerId?: string,
  sourceClient?: GatewayClient,
  diagnosticConnection?: DiagnosticConnection
) {
  if (this.disposed) return
  if (method.startsWith('agent/stream/'))
    return this.forwardAcceptedNotification(
      method,
      params,
      sourceServerId,
      sourceClient,
      diagnosticConnection
    )
  if (!this.notificationReplayGuard.accept(method, params, sourceServerId)) return
  try {
    return await this.forwardAcceptedNotification(
      method,
      params,
      sourceServerId,
      sourceClient,
      diagnosticConnection
    )
  } catch (error) {
    this.notificationReplayGuard.release(method, params, sourceServerId)
    throw error
  }
}

export async function forwardAcceptedNotification(
  this: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>,
  sourceServerId?: string,
  sourceClient?: GatewayClient,
  diagnosticConnection?: DiagnosticConnection
) {
  if (method === 'server/disconnected' && sourceClient) {
    for (const [id, owned] of this.agentConversationSubscriptions) {
      if (owned.client !== sourceClient) continue
      owned.removeCloseListener?.()
      this.agentConversationSubscriptions.delete(id)
      await emit(EXECUTOR_EVENT, {
        event: 'response.subagent.conversation',
        payload: {
          deviceId: owned.serverId,
          taskId: owned.taskId,
          data: {
            type: 'disconnected',
            threadId: owned.threadId,
            agentId: owned.agentId,
            subscriptionId: id,
            reason: 'connection_lost',
          },
        },
      })
    }
  }
  if (method === 'agent/stream/event' || method === 'agent/stream/reset') {
    const id = text(params.subscriptionId)
    const owned = id ? this.agentConversationSubscriptions.get(id) : undefined
    if (
      !owned ||
      sourceServerId !== owned.serverId ||
      sourceClient !== owned.client ||
      params.threadId !== owned.threadId ||
      params.agentId !== owned.agentId
    )
      return
    try {
      owned.assertCurrent()
    } catch {
      owned.removeCloseListener?.()
      this.agentConversationSubscriptions.delete(id!)
      return
    }
    await emit(EXECUTOR_EVENT, {
      event: 'response.subagent.conversation',
      payload: {
        deviceId: owned.serverId,
        taskId: owned.taskId,
        data: { ...params, type: method === 'agent/stream/reset' ? 'reset' : 'event' },
      },
    })
    return
  }
  if (method === 'mcp/authorizationChanged') {
    window.dispatchEvent(
      new CustomEvent('kcoder:mcp-authorization-changed', {
        detail: { ...params, deviceId: sourceServerId },
      })
    )
    return
  }
  if (this.remoteSessions.handleNotification(method, params, sourceServerId)) return
  if (method === 'automation/runStarted' && sourceServerId) {
    const threadId = text(params.threadId)
    const workspacePath = text(params.workspacePath)
    const server = (await this.servers()).find(server => server.id === sourceServerId)
    if (!threadId || !workspacePath || !server) return
    const taskId = runtimeTaskId(server, threadId)
    if (this.tasks.has(taskId)) {
      notifyRuntimeWorkChanged()
      return
    }
    const now = Date.now()
    this.tasks.set(taskId, {
      serverId: server.id,
      taskId,
      threadId,
      workspacePath,
      title: text(params.title) ?? 'Scheduled task',
      runtime: 'kcoder',
      persisted: true,
      scheduled: true,
      running: true,
      createdAt: now,
      updatedAt: now,
      runtimeHandle: { threadId },
    })
    this.taskByThread.set(this.threadKey(server.id, threadId), taskId)
    this.threadByTask.set(taskId, threadId)
    notifyRuntimeWorkChanged()
    return
  }
  if (method === 'automation/runFailed' && sourceServerId) {
    const threadId = text(params.threadId)
    const server = (await this.servers()).find(server => server.id === sourceServerId)
    if (!threadId || !server) return
    const taskId = runtimeTaskId(server, threadId)
    const task = this.tasks.get(taskId)
    if (task) this.tasks.set(taskId, { ...task, running: false, updatedAt: Date.now() })
    await emit(EXECUTOR_EVENT, {
      event: 'response.failed',
      payload: {
        taskId,
        deviceId: sourceServerId,
        subtaskId: text(params.requestId),
        data: {
          message: text(record(params.error).message) ?? 'Scheduled task could not start',
          terminalStatus: 'failed',
        },
      },
    })
    notifyRuntimeWorkChanged()
    return
  }
  if (method === 'question/resolved') {
    const requestId =
      typeof params.requestId === 'number' && Number.isFinite(params.requestId)
        ? params.requestId
        : undefined
    const threadId = text(params.threadId)
    const taskId =
      threadId && sourceServerId
        ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
        : undefined
    const pending =
      requestId !== undefined && taskId
        ? this.pendingQuestionByKey.get(`${taskId}\0${requestId}`)
        : undefined
    if (
      !pending ||
      pending.approvalDecisions ||
      (pending.questionId && pending.questionId !== text(params.questionId))
    )
      return
    this.pendingQuestionByKey.delete(`${pending.taskId}\0${pending.requestId}`)
    if (pending.autoResolutionTimer !== undefined) window.clearTimeout(pending.autoResolutionTimer)
    const reason = text(params.reason) ?? 'cancelled'
    const status = reason === 'client_response' ? 'done' : 'error'
    const explanation =
      reason === 'response_error'
        ? '回答发送后未被服务端接受。'
        : reason === 'cancelled'
          ? '问题请求已取消。'
          : '回答已由服务端确认。'
    const response = pending.submittedResponse
    const renderPayload = response ? { ...pending.renderPayload, response } : pending.renderPayload
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.updated',
      payload: {
        taskId: pending.taskId,
        subtaskId: pending.turnId,
        deviceId: sourceServerId,
        data: {
          blockId: pending.block.id,
          updates: {
            status,
            renderPayload,
            tool_output: response ?? explanation,
            toolOutput: response ?? explanation,
          },
        },
      },
    })
    return
  }
  if (method === 'approval/resolved') {
    const requestId =
      typeof params.requestId === 'number' && Number.isFinite(params.requestId)
        ? params.requestId
        : undefined
    const threadId = text(params.threadId)
    const taskId =
      threadId && sourceServerId
        ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
        : undefined
    const pending =
      requestId !== undefined && taskId
        ? this.pendingQuestionByKey.get(`${taskId}\0${requestId}`)
        : undefined
    if (!pending || (pending.approvalId && pending.approvalId !== text(params.approvalId))) return
    this.pendingQuestionByKey.delete(`${pending.taskId}\0${pending.requestId}`)
    if (pending.autoResolutionTimer !== undefined) window.clearTimeout(pending.autoResolutionTimer)
    const reason = text(params.reason) ?? 'cancelled'
    const decision = text(params.decision) ?? 'decline'
    const status = reason === 'client_response' ? 'done' : 'error'
    const explanation =
      reason === 'timeout'
        ? i18n.t('approvalUi.timeout')
        : reason === 'response_error'
          ? i18n.t('approvalUi.responseFailed')
          : reason === 'cancelled'
            ? i18n.t('approvalUi.cancelled')
            : decision === 'accept'
              ? i18n.t('approvalUi.allowed')
              : i18n.t('approvalUi.declined')
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.updated',
      payload: {
        taskId: pending.taskId,
        subtaskId: pending.turnId,
        deviceId: sourceServerId,
        data: {
          blockId: pending.block.id,
          updates: {
            status,
            tool_output: explanation,
            toolOutput: explanation,
          },
        },
      },
    })
    return
  }
  const threadId = text(params.threadId) ?? text(record(params.thread).id)
  const taskId =
    (threadId && sourceServerId
      ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
      : null) ??
    threadId ??
    'kcoder-task'
  const turn = record(params.turn)
  const turnId = text(params.turnId) ?? text(turn.id) ?? 'kcoder-turn'
  const turnKey = `${taskId}:${turnId}`
  const currentAttempt = this.turnAttemptIds.get(turnKey)
  const terminalAttempt = text(params.attemptId) ?? text(turn.attemptId)
  // A late terminal from an earlier continuation must not consume the
  // current attempt's text, identity or running state.
  if (
    method === 'turn/completed' &&
    currentAttempt &&
    terminalAttempt &&
    currentAttempt !== terminalAttempt
  )
    return
  if (method === 'turn/started') this.turnAttemptIds.set(turnKey, text(params.attemptId) ?? turnId)
  const task = this.tasks.get(taskId)
  if (task && sourceServerId && sourceClient) {
    this.toolPathPreviews.handle(
      method,
      params,
      sourceServerId,
      taskId,
      sourceClient,
      this.turnAttemptIds.get(turnKey) ?? null,
      sourceClient.supportsExperimental?.('toolPathPreviewV1') === true
    )
  }
  const base = {
    taskId,
    subtaskId: this.turnAttemptIds.get(turnKey) ?? turnId,
    deviceId: task?.serverId ?? (await this.server()).id,
  }
  if (method === 'computerUse/stateChanged') {
    if (
      task &&
      sourceServerId === task.serverId &&
      sourceClient === this.clientByTask.get(taskId) &&
      this.activeTurnByTask.get(taskId)?.turnId === turnId
    ) {
      computerUseStates.apply(this, task.serverId, taskId, turnId, params)
      if (['revoked', 'unknown'].includes(String(record(params.diagnostic).authorization)))
        computerUseConsent.set(task.serverId, taskId, false)
    }
    return
  }
  if (method === 'thread/goal/updated' || method === 'thread/goal/continuation') {
    await emit(EXECUTOR_EVENT, {
      event:
        method === 'thread/goal/continuation'
          ? 'runtime.goal.continuation'
          : params.goal == null
            ? 'runtime.goal.cleared'
            : 'runtime.goal.updated',
      payload: { ...base, subtaskId: text(params.turnId), data: { ...params, threadId } },
    })
    return
  }
  if (method === 'turn/started') {
    const attemptId = text(params.attemptId) ?? text(turn.attemptId)
    if (
      task &&
      sourceServerId === task.serverId &&
      sourceClient === this.clientByTask.get(taskId) &&
      attemptId &&
      typeof params.sequence === 'number'
    ) {
      computerUseStates.beginAttempt(
        this,
        task.serverId,
        taskId,
        turnId,
        attemptId,
        params.sequence
      )
    }
    if (this.activeTurnByTask.get(taskId)?.turnId !== turnId) {
      this.trackActiveTurn(taskId, turnId, turn.internal === true)
    }
    if (task) this.tasks.set(taskId, { ...task, running: true, updatedAt: Date.now() })
    this.turnText.set(turnKey, '')
    await emit(EXECUTOR_EVENT, { event: 'response.created', payload: { ...base, data: {} } })
    return
  }
  if (method === 'item/delta') {
    const delta = rawDeltaText(record(params.delta).text)
    if (delta === null || delta === '') return
    this.turnText.set(turnKey, `${this.turnText.get(turnKey) ?? ''}${delta}`)
    await emit(EXECUTOR_EVENT, {
      event: 'response.output_text.delta',
      payload: { ...base, data: { delta } },
    })
    return
  }
  if (method === 'agent/steer/applied') {
    const agentId = text(params.agentId)
    const messageId = text(params.messageId)
    if (!agentId || !messageId) return
    const job = this.backgroundJobById.get(agentId, taskId, base.deviceId)
    await emit(EXECUTOR_EVENT, {
      event: 'response.subagent.activity',
      payload: {
        ...base,
        data: {
          agent_path: agentId,
          agent_id: agentId,
          agent_name: job?.toolName,
          kind: 'background',
          status: 'running',
          steer_status: 'applied',
          message_id: messageId,
          client_message_id: text(params.clientMessageId),
          occurred_at_ms: finiteNumber(params.appliedAtMs, Date.now()),
        },
      },
    })
    return
  }
  if (method === 'item/event') {
    const event = record(params.event)
    const eventType = text(event.type)
    if (eventType === 'error') {
      const providerFailure = decodeProviderFailure(event.provider_failure)
      if (!providerFailure) return
      await emit(EXECUTOR_EVENT, {
        event: 'response.failed',
        payload: {
          ...base,
          data: {
            message: text(event.error) ?? 'Provider request failed',
            provider_failure: providerFailure,
          },
        },
      })
      return
    }
    if (eventType === 'background_job_associated') {
      const jobId = text(event.id)
      const toolCallId = text(event.tool_call_id)
      if (!jobId || !toolCallId) return
      const toolName = this.toolNameByCall.get(`${taskId}\0${toolCallId}`) ?? 'spawn_agent'
      const job = {
        runId: text(record(record(params.identity).run).runId) ?? undefined,
        parentAttemptId: currentAttempt ?? text(params.attemptId) ?? undefined,
        taskId,
        turnId,
        toolCallId,
        toolName,
        serverId: base.deviceId,
      }
      const interrupted = this.interruptedBackgroundToolByKey.get(`${taskId}\0${toolCallId}`)
      if (interrupted) {
        await this.emitBackgroundToolLifecycle(
          interrupted.agentId,
          job,
          'interrupted',
          text(interrupted.output.output) ?? ''
        )
        await emit(EXECUTOR_EVENT, {
          event: 'response.subagent.activity',
          payload: {
            ...base,
            data: {
              agent_path: interrupted.agentId,
              agent_name: toolName,
              kind: 'background',
              status: 'interrupted',
            },
          },
        })
        return
      }
      this.backgroundJobById.set(jobId, job)
      await this.emitBackgroundToolLifecycle(jobId, job, 'running')
      await emit(EXECUTOR_EVENT, {
        event: 'response.subagent.activity',
        payload: {
          ...base,
          data: {
            agent_path: jobId,
            agent_name: toolName,
            kind: 'background',
            status: 'running',
          },
        },
      })
      reportBackgroundRunDiagnostic({
        connection: diagnosticConnection,
        threadId,
        runId: job.runId,
        attemptId: job.parentAttemptId,
        status: 'running',
      })
      return
    }
    if (
      eventType === 'background_job_progress' ||
      eventType === 'background_job_promoted' ||
      eventType === 'background_job_paused'
    ) {
      const jobId = text(event.id)
      const job = jobId ? this.backgroundJobById.get(jobId, taskId, base.deviceId) : undefined
      if (!jobId || !job) return
      const runId = text(record(record(params.identity).run).runId)
      if (runId && job.runId !== runId) return
      const status = eventType === 'background_job_paused' ? 'paused' : 'running'
      await this.emitBackgroundToolLifecycle(jobId, job, status, text(event.reason) ?? '')
      await emit(EXECUTOR_EVENT, {
        event: 'response.subagent.activity',
        payload: {
          taskId: job.taskId,
          subtaskId: job.turnId,
          deviceId: job.serverId,
          data: {
            agent_path: jobId,
            agent_name: job.toolName,
            kind: 'background',
            status,
          },
        },
      })
      return
    }
    if (
      eventType === 'background_job_completed' ||
      eventType === 'background_job_failed' ||
      eventType === 'background_job_cancelled' ||
      eventType === 'background_job_halted'
    ) {
      const jobId = text(event.id)
      const job = jobId ? this.backgroundJobById.get(jobId, taskId, base.deviceId) : undefined
      if (!jobId || !job) return
      const runId = text(record(record(params.identity).run).runId)
      if (runId && job.runId !== runId) return
      const status =
        eventType === 'background_job_completed'
          ? event.is_error === true
            ? 'failed'
            : 'completed'
          : eventType === 'background_job_cancelled' || eventType === 'background_job_halted'
            ? 'interrupted'
            : 'failed'
      const output = text(event.text) ?? text(event.error) ?? text(event.reason) ?? ''
      const jobBase = {
        taskId: job.taskId,
        subtaskId: job.turnId,
        deviceId: job.serverId,
      }
      await this.emitBackgroundToolLifecycle(jobId, job, status, output)
      await emit(EXECUTOR_EVENT, {
        event: 'response.subagent.activity',
        payload: {
          ...jobBase,
          data: {
            agent_path: jobId,
            agent_name: job.toolName,
            kind: 'background',
            status,
          },
        },
      })
      if (runId)
        reportBackgroundRunDiagnostic({
          connection: diagnosticConnection,
          threadId,
          runId,
          attemptId: job.parentAttemptId,
          status,
        })
      this.backgroundJobById.delete(jobId, job)
      this.toolNameByCall.delete(`${job.taskId}\0${job.toolCallId}`)
      return
    }
    if (eventType !== 'assistant_thinking_delta') return
    const delta = text(event.text)
    if (!delta) return
    await emit(EXECUTOR_EVENT, {
      event: 'response.reasoning_summary_text.delta',
      payload: { ...base, data: { delta } },
    })
    return
  }
  if (method === 'item/started') {
    const item = record(params.item)
    if (item.type !== 'toolCall') return
    const callId = text(item.id)
    const toolName = text(item.name) ?? 'tool'
    if (callId) {
      const callKey = `${taskId}\0${callId}`
      const interrupted = this.interruptedBackgroundToolByKey.get(callKey)
      if (interrupted) {
        await this.emitBackgroundToolLifecycle(
          interrupted.agentId,
          {
            taskId,
            turnId,
            toolCallId: callId,
            toolName,
            serverId: base.deviceId,
          },
          'interrupted',
          text(interrupted.output.output) ?? ''
        )
        return
      }
      this.toolNameByCall.set(callKey, toolName)
    }
    await emit(EXECUTOR_EVENT, {
      event: 'response.output_item.added',
      payload: {
        ...base,
        data: {
          item: {
            type: 'function_call',
            call_id: callId,
            name: toolName,
            arguments: JSON.stringify(record(item.input)),
          },
        },
      },
    })
    return
  }
  if (method === 'item/completed') {
    const item = record(params.item)
    if (item.type !== 'toolCall') return
    const callId = text(item.id)
    const callKey = callId ? `${taskId}\0${callId}` : undefined
    const interrupted = callKey ? this.interruptedBackgroundToolByKey.get(callKey) : undefined
    if (callId && interrupted) {
      await this.emitBackgroundToolLifecycle(
        interrupted.agentId,
        {
          taskId,
          turnId,
          toolCallId: callId,
          toolName: text(item.name) ?? 'spawn_agent',
          serverId: base.deviceId,
        },
        'interrupted',
        text(interrupted.output.output) ?? ''
      )
      return
    }
    const backgroundEntry = callId
      ? [...this.backgroundJobById.entries()].find(
          ([, job]) => job.taskId === taskId && job.toolCallId === callId
        )
      : undefined
    const backgroundOutput = backgroundEntry
      ? {
          ...record(item.output),
          ...(typeof item.output === 'string' && item.output ? { output: item.output } : {}),
          agent_id: backgroundEntry[0],
          status: 'running',
        }
      : undefined
    await emit(EXECUTOR_EVENT, {
      event: 'response.output_item.done',
      payload: {
        ...base,
        data: {
          item: {
            type: 'function_call',
            call_id: callId,
            name: text(item.name) ?? 'tool',
            status: item.status === 'failed' ? 'failed' : 'completed',
            output: backgroundOutput ?? toolObservationOutput(item),
          },
        },
      },
    })
    if (
      callId &&
      ![...this.backgroundJobById.values()].some(
        job => job.taskId === taskId && job.toolCallId === callId
      )
    ) {
      this.toolNameByCall.delete(`${taskId}\0${callId}`)
    }
    return
  }
  if (method === 'turn/completed') {
    if (task) computerUseStates.unconfirmed(this, task.serverId, taskId, turnId)
    const status = text(turn.status) ?? 'completed'
    const terminalError = text(record(params.error).message)
    const content = this.turnText.get(turnKey) ?? ''
    this.turnText.delete(turnKey)
    this.turnAttemptIds.delete(turnKey)
    if (this.pendingTurnStartByTask.has(taskId)) {
      this.completedTurnKeys.add(turnKey)
      if (this.completedTurnKeys.size > 512) {
        const oldest = this.completedTurnKeys.values().next().value
        if (oldest) this.completedTurnKeys.delete(oldest)
      }
    }
    const active = this.activeTurnByTask.get(taskId)
    if (task && (!active || active.turnId === turnId))
      this.tasks.set(taskId, { ...task, running: false, updatedAt: Date.now() })
    if (task?.scheduled) notifyRuntimeWorkChanged()
    if (active?.turnId === turnId) {
      active.complete()
      this.activeTurnByTask.delete(taskId)
    }
    for (const [key, pending] of this.pendingQuestionByKey) {
      if (pending.taskId !== taskId || pending.turnId !== turnId) continue
      this.pendingQuestionByKey.delete(key)
      if (pending.autoResolutionTimer !== undefined) {
        window.clearTimeout(pending.autoResolutionTimer)
      }
      await emit(EXECUTOR_EVENT, {
        event: 'response.block.updated',
        payload: {
          ...base,
          data: {
            blockId: pending.block.id,
            updates: {
              status: 'error',
              tool_output: '交互请求随当前回合结束，未收到服务端确认。',
              toolOutput: '交互请求随当前回合结束，未收到服务端确认。',
            },
          },
        },
      })
    }
    await emit(EXECUTOR_EVENT, {
      event: status === 'completed' ? 'response.completed' : 'response.failed',
      payload: {
        ...base,
        data: {
          terminalStatus: status,
          ...(status === 'completed' ? { value: content } : { message: terminalError ?? status }),
          ...(status !== 'completed'
            ? { provider_failure: decodeProviderFailure(record(params.error).details) }
            : {}),
          turnId,
          turn_id: turnId,
          ...(text(record(params.fileChanges).artifact_id)
            ? {
                file_changes: {
                  ...record(params.fileChanges),
                  device_id: base.deviceId,
                },
              }
            : {}),
        },
      },
    })
  }
}
