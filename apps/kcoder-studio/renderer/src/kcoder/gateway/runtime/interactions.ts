import { agentInteractionSource } from '../../agentInteractionSource'
import i18n from '@/i18n'
import { safeGatewayFailureDiagnostic } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import { interactionReplyBinding } from '../../interactionReplyBinding'
import { EXECUTOR_EVENT, type PendingGatewayQuestion, record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

export async function forwardServerRequest(
  this: GatewayRuntimeCore,
  client: GatewayClient,
  message: { id?: number; method?: string; params?: Record<string, unknown> },
  sourceServerId: string
) {
  if (
    (message.method !== 'question/request' && message.method !== 'approval/request') ||
    typeof message.id !== 'number'
  ) {
    if (typeof message.id === 'number') {
      client.respondError?.(message.id, -32601, `不支持的 app-server 请求：${message.method ?? ''}`)
    }
    return
  }
  const params = record(message.params)
  const threadId = text(params.threadId)
  const turnId = text(params.turnId)
  const taskId = threadId
    ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
    : undefined
  if (!taskId || !threadId || !turnId) {
    client.respondError?.(message.id, -32040, '交互请求无法关联到活动任务')
    return
  }
  if (message.method === 'approval/request') {
    await this.forwardApprovalRequest(client, message.id, params, taskId, turnId)
    return
  }
  const questions = Array.isArray(params.questions)
    ? params.questions.map((value, index) => {
        const question = record(value)
        return {
          id: text(question.id) ?? `question-${index + 1}`,
          header: text(question.header) ?? '',
          question: text(question.prompt) ?? text(question.question) ?? `Question ${index + 1}`,
          options: Array.isArray(question.options)
            ? question.options.map(optionValue => {
                const option = record(optionValue)
                return {
                  label: text(option.label) ?? text(option.value) ?? '',
                  description: text(option.description) ?? '',
                  ...(text(option.preview) ? { preview: text(option.preview) } : {}),
                }
              })
            : [],
          isOther: question.allowsFreeform !== false,
          isSecret: question.isSecret === true,
          multiSelect: question.multiSelect === true,
        }
      })
    : []
  let sourceAgent
  try {
    sourceAgent = agentInteractionSource(params.sourceAgent, threadId)
  } catch {
    client.respondError?.(message.id, -32040, 'invalid subagent interaction origin')
    return
  }
  const requestId = message.id
  const itemId = text(params.questionId) ?? `question-${requestId}`
  const renderPayload = {
    kind: 'request_user_input',
    ...(sourceAgent ? { sourceAgent } : {}),
    requestId,
    itemId,
    questions,
    ...(params.annotations === undefined ? {} : { annotations: params.annotations }),
  }
  const block = {
    id: `request-user-input-${requestId}`,
    type: 'tool',
    tool_name: 'request_user_input',
    toolName: 'request_user_input',
    status: 'pending',
    timestamp: Date.now(),
    render_payload: renderPayload,
    renderPayload,
  }
  const pendingQuestion: PendingGatewayQuestion = {
    client,
    requestId,
    taskId,
    turnId,
    block,
    renderPayload,
    questionId: itemId,
  }
  const autoResolutionMs = Number(params.autoResolutionMs)
  if (
    Number.isFinite(autoResolutionMs) &&
    autoResolutionMs >= 1_000 &&
    autoResolutionMs <= 240_000
  ) {
    pendingQuestion.autoResolutionTimer = window.setTimeout(() => {
      void this.respondToTaskQuestion(taskId, {
        requestId,
        answers: {},
        annotations: { autoResolved: true },
      }).catch(error =>
        console.warn('[KCoder] 自动解决交互请求失败', safeGatewayFailureDiagnostic(error))
      )
    }, autoResolutionMs)
  }
  this.pendingQuestionByKey.set(`${taskId}\0${requestId}`, pendingQuestion)
  await emit(EXECUTOR_EVENT, {
    event: 'response.block.created',
    payload: {
      taskId,
      subtaskId: turnId,
      deviceId: sourceServerId,
      data: { block },
    },
  })
}

export async function forwardApprovalRequest(
  this: GatewayRuntimeCore,
  client: GatewayClient,
  requestId: number,
  params: Record<string, unknown>,
  taskId: string,
  turnId: string
) {
  const approvalId = text(params.approvalId) ?? `approval-${requestId}`
  const action = record(params.action)
  const actionType = text(action.type)
  const toolInput =
    actionType === 'tool' ? (JSON.stringify(record(action.input), null, 2) ?? '{}') : ''
  const permissionInput =
    actionType === 'permission' ? (JSON.stringify(record(action.permissions), null, 2) ?? '{}') : ''
  const validAction =
    (actionType === 'command' && Boolean(text(action.command))) ||
    (actionType === 'file_change' && Boolean(text(action.itemId))) ||
    (actionType === 'permission' && permissionInput.length <= 4_000) ||
    (actionType === 'tool' && Boolean(text(action.name)) && toolInput.length <= 4_000)
  if (!validAction) {
    // Even this fail-closed decline must be attributable on a bound
    // connection, otherwise the server keeps the interaction pending.
    const declineBinding = interactionReplyBinding({
      requiresBinding: client.supportsExperimental?.('interactionBindingV1') === true,
      approvalId: text(params.approvalId),
      threadId: text(params.threadId),
      turnId: text(params.turnId),
    })
    client.respond?.(requestId, {
      decision: 'decline',
      ...(declineBinding.ok ? declineBinding.fields : {}),
    })
    await emit(EXECUTOR_EVENT, {
      event: 'response.failed',
      payload: {
        taskId,
        subtaskId: turnId,
        deviceId: this.tasks.get(taskId)?.serverId,
        data: {
          message: i18n.t('approvalUi.unsafe'),
        },
      },
    })
    return
  }
  const actionDescription =
    actionType === 'command'
      ? `Command: ${text(action.command)}`
      : actionType === 'file_change'
        ? `File change: ${text(action.path) ?? 'The current task requests a file write (no additional directory requested)'}`
        : actionType === 'permission'
          ? `Permission scope (cwd: ${text(action.cwd) ?? 'unknown'}):\n${permissionInput}`
          : `Tool: ${text(action.name)}\n${toolInput}`
  const reason = text(params.reason)
  const availableDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter(value => typeof value === 'string')
    : []
  const allowsSession = availableDecisions.some(
    decision => decision === 'acceptForSession' || decision === 'accept_for_session'
  )
  const questions = [
    {
      id: approvalId,
      header: 'Permission request',
      question: [reason, actionDescription].filter(Boolean).join('\n\n'),
      options: [
        { label: 'Allow once', description: 'Allow this operation once.' },
        ...(allowsSession
          ? [
              {
                label: 'Always allow for this session',
                description: 'Allow similar operations for the current session.',
              },
            ]
          : []),
        { label: 'Decline', description: 'Decline this operation.' },
      ],
      isOther: false,
      multiSelect: false,
    },
  ]
  const renderPayload = {
    approvalPresentation: {
      kind: actionType,
      subject:
        actionType === 'command'
          ? text(action.command)
          : actionType === 'file_change'
            ? text(action.path)
            : actionType === 'permission'
              ? text(action.cwd)
              : text(action.name),
      input:
        actionType === 'permission' ? permissionInput : actionType === 'tool' ? toolInput : null,
      reason,
    },
    kind: 'request_user_input',
    requestId,
    itemId: approvalId,
    questions,
  }
  const block = {
    id: `request-user-input-${requestId}`,
    type: 'tool',
    tool_name: 'request_user_input',
    toolName: 'request_user_input',
    status: 'pending',
    timestamp: Date.now(),
    render_payload: renderPayload,
    renderPayload,
  }
  this.pendingQuestionByKey.set(`${taskId}\0${requestId}`, {
    client,
    requestId,
    taskId,
    turnId,
    block,
    renderPayload,
    approvalId,
    approvalDecisions: {
      'Allow once': 'accept',
      ...(allowsSession ? { 'Always allow for this session': 'accept_for_session' as const } : {}),
      Decline: 'decline',
    },
  })
  await emit(EXECUTOR_EVENT, {
    event: 'response.block.created',
    payload: {
      taskId,
      subtaskId: turnId,
      deviceId: this.tasks.get(taskId)?.serverId,
      data: { block },
    },
  })
}

export async function respondToTaskQuestion(
  this: GatewayRuntimeCore,
  taskId: string | null,
  response: Record<string, unknown>
) {
  if (!taskId) throw new Error('问题响应缺少任务地址')
  const responseRequestId =
    typeof response.requestId === 'number' || typeof response.requestId === 'string'
      ? String(response.requestId)
      : typeof response.request_id === 'number' || typeof response.request_id === 'string'
        ? String(response.request_id)
        : null
  const taskPending = [...this.pendingQuestionByKey.values()].filter(
    pending => pending.taskId === taskId
  )
  const pending = responseRequestId
    ? this.pendingQuestionByKey.get(`${taskId}\0${responseRequestId}`)
    : taskPending.length === 1
      ? taskPending[0]
      : undefined
  if (!pending) {
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      error:
        taskPending.length > 1 && !responseRequestId
          ? 'request_user_input response is ambiguous without requestId'
          : 'request_user_input is not pending',
      code:
        taskPending.length > 1 && !responseRequestId
          ? 'ambiguous_request_user_input'
          : 'missing_request_user_input',
    }
  }
  if (response.sourceAgent !== undefined) {
    const expected = pending.renderPayload.sourceAgent
    const actual = agentInteractionSource(response.sourceAgent, this.threadByTask.get(taskId) ?? '')
    if (!expected || !actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      return {
        success: false,
        accepted: false,
        taskId,
        runtime: 'kcoder',
        code: 'source_agent_conflict',
        error: 'question source agent identity changed',
      }
    }
  }
  if (!pending.client.respond) throw new Error('KCoder RPC 客户端不支持双向问题响应')
  if (pending.responsePending) {
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      error: 'request_user_input response is awaiting server confirmation',
      code: 'request_user_input_response_pending',
    }
  }
  const answers = record(response.answers)
  const selectedApprovalLabel = Object.values(answers)
    .flatMap(value => {
      const answerValues = record(value).answers
      return Array.isArray(answerValues) ? answerValues : []
    })
    .find(value => typeof value === 'string')
  // A connection that negotiated `interactionBindingV1` rejects a reply that
  // does not name the interaction, so the identity is echoed here and a reply
  // that cannot be attributed is refused before it is sent.
  const binding = interactionReplyBinding({
    requiresBinding: pending.client.supportsExperimental?.('interactionBindingV1') === true,
    approvalId: pending.approvalId,
    questionId: pending.questionId,
    threadId: this.threadByTask.get(pending.taskId),
    turnId: pending.turnId,
  })
  if (!binding.ok) throw new Error(`无法确认交互归属：${binding.reason}`)
  pending.responsePending = true
  pending.submittedResponse = response
  try {
    pending.client.respond(
      pending.requestId,
      pending.approvalDecisions
        ? {
            decision:
              (typeof selectedApprovalLabel === 'string'
                ? pending.approvalDecisions[selectedApprovalLabel]
                : undefined) ?? 'decline',
            ...binding.fields,
          }
        : {
            answers,
            ...(response.annotations === undefined ? {} : { annotations: response.annotations }),
            ...binding.fields,
          }
    )
  } catch (error) {
    this.pendingQuestionByKey.delete(`${taskId}\0${pending.requestId}`)
    if (pending.autoResolutionTimer !== undefined) window.clearTimeout(pending.autoResolutionTimer)
    const message = error instanceof Error ? error.message : String(error)
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.updated',
      payload: {
        taskId,
        subtaskId: pending.turnId,
        deviceId: this.tasks.get(taskId)?.serverId,
        data: {
          blockId: pending.block.id,
          updates: {
            status: 'error',
            tool_output: `响应发送失败：${message}`,
            toolOutput: `响应发送失败：${message}`,
          },
        },
      },
    })
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      error: message,
      code: 'request_user_input_send_failed',
    }
  }
  const task = this.tasks.get(taskId)
  return {
    success: true,
    accepted: true,
    deviceId: task?.serverId,
    taskId,
    runtime: 'kcoder',
    pendingServerConfirmation: true,
  }
}
