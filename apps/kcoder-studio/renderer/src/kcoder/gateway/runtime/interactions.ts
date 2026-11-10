import { captureTaskInteraction } from './taskInteractions'
import { isMcpAppOperation } from './mcpAppOperationScope'
import { agentInteractionSource } from '../../agentInteractionSource'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { isQuestionResponse } from '../../../../../shared/generated/contractGuards.mjs'
import i18n from '@/i18n'
import { safeGatewayFailureDiagnostic } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import { interactionReplyBinding } from '../../interactionReplyBinding'
import { EXECUTOR_EVENT, type GatewayTask, type PendingGatewayQuestion, record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

// Replays share an in-flight or successful publication. Only a failed UI
// projection may retry; the original pending request and answer guard survive.
const questionPublications = new WeakMap<PendingGatewayQuestion, Promise<void>>()
// A native terminal receipt closes input immediately. Retain its first UI
// projection until publication succeeds, including across recovery replays.
const terminalPublications = new WeakMap<PendingGatewayQuestion, {
  publish: () => Promise<void>
  promise?: Promise<void>
}>()

export function publishInteractionResolution(
  runtime: GatewayRuntimeCore,
  pending: PendingGatewayQuestion,
  publish: () => Promise<void>
): Promise<void> {
  let terminal = terminalPublications.get(pending)
  if (!terminal) {
    terminal = { publish }
    terminalPublications.set(pending, terminal)
  }
  const original = terminal
  if (!original.promise) {
    original.promise = original.publish().then(() => {
      const key = `${pending.taskId}\0${pending.requestId}`
      // Publication can yield to another request reusing the transport ID.
      if (runtime.pendingQuestionByKey.get(key) === pending) runtime.pendingQuestionByKey.delete(key)
      terminalPublications.delete(pending)
    }, error => {
      original.promise = undefined
      throw error
    })
  }
  return original.promise
}
// A retained request belongs to its original task address even if the same
// client object survives a directory refresh or an in-place task rebind.
const questionTaskBindings = new WeakMap<PendingGatewayQuestion,
  Pick<GatewayTask, 'serverId' | 'threadId' | 'workspacePath'> & { rpcThreadId?: string }>()

function isCurrentInteractionClient(runtime: GatewayRuntimeCore, taskId: string, client: GatewayClient, connectionId?: string, pending?: PendingGatewayQuestion) {
  // App-server loss is recorded before ordered notification cleanup can run.
  return !runtime.disposed && runtime.clientByTask.get(taskId) === client &&
    !runtime.appServerDisconnectedClients.has(client) &&
    (connectionId === undefined || client.diagnosticConnection?.connectionId === connectionId) &&
    (!pending || isCurrentInteractionTaskBinding(runtime, pending))
}

// Replies and terminal projections must use the same captured task address.
export function isCurrentInteractionTaskBinding(runtime: GatewayRuntimeCore, pending: PendingGatewayQuestion) {
  const binding = questionTaskBindings.get(pending)
  if (!binding) return true
  const task = runtime.tasks.get(pending.taskId)
  return Boolean(task && task.serverId === binding.serverId && task.threadId === binding.threadId &&
    sameWorkspacePath(task.workspacePath, binding.workspacePath) &&
    runtime.threadByTask?.get(pending.taskId) === binding.rpcThreadId)
}

export async function forwardServerRequest(
  this: GatewayRuntimeCore,
  client: GatewayClient,
  message: { id?: number; method?: string; params?: Record<string, unknown> },
  sourceServerId: string,
  connectionId = client.diagnosticConnection?.connectionId
) {
  // The ordered queue may outlive its socket while retaining the client object.
  if (client.diagnosticConnection?.connectionId !== connectionId) return
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
  const appServerEpoch = text(params.appServerEpoch) ?? undefined
  const taskId = threadId
    ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
    : undefined
  if (!taskId || !threadId || !turnId) {
    client.respondError?.(message.id, -32040, '交互请求无法关联到活动任务')
    return
  }
  // A late request from a detached client must not replace the current owner's
  // pending object, even when the transport reuses its request ID.
  if (!isCurrentInteractionClient(this, taskId, client, connectionId)) return
  const previous = this.pendingQuestionByKey.get(`${taskId}\0${message.id}`)
  const questionId = message.method === 'question/request'
    ? text(params.questionId) ?? `question-${message.id}` : undefined
  const approvalId = message.method === 'approval/request'
    ? text(params.approvalId) ?? `approval-${message.id}` : undefined
  if (
    previous?.client === client &&
    previous.turnId === turnId &&
    previous.appServerEpoch === appServerEpoch &&
    previous.questionId === questionId &&
    previous.approvalId === approvalId
  ) {
    // Preserve the original answer and timer, but let an authoritative replay
    // recover a projection whose earlier target lookup or capture failed.
    previous.connectionId = connectionId
    await captureTaskInteraction(this, client, taskId, params, message.id).catch(() => {})
    if (!previous.responsePending) await publishPendingQuestion(this, previous, sourceServerId)
    return
  }
  if (message.method === 'approval/request') {
    await this.forwardApprovalRequest(client, message.id, params, taskId, turnId, connectionId)
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
    // Native questions keep every item, even when their text resembles a plan.
    allowImplementationPlanShortcut: false,
    ...(sourceAgent ? { sourceAgent } : {}),
    requestId,
    itemId,
    threadId,
    turnId,
    ...(appServerEpoch === undefined ? {} : { appServerEpoch }),
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
    connectionId,
    requestId,
    taskId,
    turnId,
    appServerEpoch,
    presentationSubtaskId: this.turnAttemptIds.get(`${taskId}:${turnId}`) ?? turnId,
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
        ...(sourceAgent ? { sourceAgent } : {}),
        answers: {},
        annotations: { autoResolved: true },
      }, pendingQuestion).catch(error =>
        console.warn('[KCoder] 自动解决交互请求失败', safeGatewayFailureDiagnostic(error))
      )
    }, autoResolutionMs)
  }
  storePendingQuestion(this, pendingQuestion)
  await captureTaskInteraction(this, client, taskId, params, requestId).catch(() => {})
  await publishPendingQuestion(this, pendingQuestion, sourceServerId)
}

export async function forwardApprovalRequest(
  this: GatewayRuntimeCore,
  client: GatewayClient,
  requestId: number,
  params: Record<string, unknown>,
  taskId: string,
  turnId: string,
  connectionId = client.diagnosticConnection?.connectionId
) {
  if (!isCurrentInteractionClient(this, taskId, client, connectionId)) return
  const approvalId = text(params.approvalId) ?? `approval-${requestId}`
  const appServerEpoch = text(params.appServerEpoch) ?? undefined
  const presentationSubtaskId = this.turnAttemptIds.get(`${taskId}:${turnId}`) ?? turnId
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
        subtaskId: presentationSubtaskId,
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
    ...(isMcpAppOperation(client, taskId, turnId) ? { operationOrigin: 'mcp_app' } : {}),
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
    threadId: text(params.threadId) ?? this.threadByTask.get(taskId),
    turnId,
    ...(appServerEpoch === undefined ? {} : { appServerEpoch }),
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
  const pendingQuestion: PendingGatewayQuestion = {
    client,
    connectionId,
    requestId,
    taskId,
    turnId,
    appServerEpoch,
    presentationSubtaskId,
    block,
    renderPayload,
    approvalId,
    approvalDecisions: {
      'Allow once': 'accept',
      ...(allowsSession ? { 'Always allow for this session': 'accept_for_session' as const } : {}),
      Decline: 'decline',
    },
  }
  storePendingQuestion(this, pendingQuestion)
  await captureTaskInteraction(this, client, taskId, params, requestId).catch(() => {})
  await publishPendingQuestion(this, pendingQuestion, this.tasks.get(taskId)?.serverId)
}

async function publishPendingQuestion(
  runtime: GatewayRuntimeCore,
  pending: PendingGatewayQuestion,
  deviceId: string | undefined
) {
  if (!isCurrentPendingQuestion(runtime, pending) || terminalPublications.has(pending)) return
  const previous = questionPublications.get(pending)
  if (previous) return previous
  const publication = emit(EXECUTOR_EVENT, {
    event: 'response.block.created',
    payload: {
      taskId: pending.taskId,
      subtaskId: pending.presentationSubtaskId ?? pending.turnId,
      deviceId,
      data: { block: pending.block },
    },
  })
  questionPublications.set(pending, publication)
  try {
    await publication
  } catch (error) {
    questionPublications.delete(pending)
    throw error
  }
}

function isCurrentPendingQuestion(runtime: GatewayRuntimeCore, pending: PendingGatewayQuestion) {
  // Capture can yield to a resolution, disconnect or a replacement request.
  const key = `${pending.taskId}\0${pending.requestId}`
  const original = runtime.pendingQuestionByKey.get(key) === pending
  if (isCurrentInteractionClient(runtime, pending.taskId, pending.client, pending.connectionId, pending) && original)
    return true
  if (original) runtime.pendingQuestionByKey.delete(key)
  if (pending.autoResolutionTimer !== undefined) window.clearTimeout(pending.autoResolutionTimer)
  return false
}

function storePendingQuestion(runtime: GatewayRuntimeCore, pending: PendingGatewayQuestion) {
  const key = `${pending.taskId}\0${pending.requestId}`
  const task = runtime.tasks.get(pending.taskId)
  if (task) questionTaskBindings.set(pending, { serverId: task.serverId, threadId: task.threadId,
    workspacePath: task.workspacePath, rpcThreadId: runtime.threadByTask?.get(pending.taskId) })
  const previous = runtime.pendingQuestionByKey.get(key)
  if (previous?.autoResolutionTimer !== undefined) window.clearTimeout(previous.autoResolutionTimer)
  runtime.pendingQuestionByKey.set(key, pending)
}

export async function respondToTaskQuestion(
  this: GatewayRuntimeCore,
  taskId: string | null,
  response: Record<string, unknown>,
  expected?: PendingGatewayQuestion
) {
  if (!taskId) throw new Error('问题响应缺少任务地址')
  // Keep the dispatched answer and its later confirmation independent of
  // caller-owned drafts, including nested selections, annotations and IDs.
  response = structuredClone(response)
  const requestIds = [response.requestId, response.request_id].filter(value => value !== undefined)
  // Only omission permits the single-pending legacy lookup. Explicit aliases
  // must name the same request before selecting a question or approval.
  if (requestIds.some(value => typeof value === 'string'
    ? !value.trim()
    : typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) ||
      requestIds.some(value => String(value) !== String(requestIds[0]))) {
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      code: 'interaction_request_conflict',
      error: 'question or approval request identity is invalid or conflicting',
    }
  }
  const responseRequestId = requestIds.length ? String(requestIds[0]) : null
  const taskPending = [...this.pendingQuestionByKey.values()].filter(
    pending => pending.taskId === taskId
  )
  const pending = responseRequestId
    ? this.pendingQuestionByKey.get(`${taskId}\0${responseRequestId}`)
    : taskPending.length === 1
      ? taskPending[0]
      : undefined
  if (expected && pending !== expected) {
    return {success:false,accepted:false,taskId,runtime:'kcoder',code:'original_interaction_changed'}
  }
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
  if (!isCurrentInteractionClient(this, taskId, pending.client, pending.connectionId, pending)) {
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      code: 'original_interaction_changed',
      error: i18n.t('workbench.subagent_detail_disconnected'),
    }
  }
  // A request ID can be reused after reconnect. Never replace a stale card's
  // explicit item identity with the current pending operation's wire binding.
  const itemId = pending.approvalId ?? pending.questionId
  if ([response.itemId, response.item_id].some(value => value !== undefined && value !== itemId)) {
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      code: 'interaction_item_conflict',
      error: 'question or approval item identity changed',
    }
  }
  // A reused request/item ID cannot repair an explicitly stale task, turn or
  // server lifetime. Validate before constructing the current native binding.
  const originalBinding = {
    threadId: this.threadByTask.get(taskId),
    turnId: pending.turnId,
    questionId: pending.questionId,
    approvalId: pending.approvalId,
    appServerEpoch: pending.appServerEpoch,
  }
  if (Object.entries(originalBinding).some(([field, value]) =>
    response[field] != null && response[field] !== value
  )) {
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      code: 'interaction_binding_conflict',
      error: 'question or approval response belongs to another interaction',
    }
  }
  // Omission is the parent-task namespace, not permission to answer a child.
  // Reused transport/item IDs must still name the original source and run.
  if (pending.renderPayload.sourceAgent !== undefined || response.sourceAgent !== undefined) {
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
  if (pending.responsePending || terminalPublications.has(pending)) {
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      error: 'request_user_input response is awaiting server confirmation',
      code: 'request_user_input_response_pending',
    }
  }
  // Validate before projection: record() would turn malformed maps into an
  // empty answer, and approval projection could turn malformed items into a decline.
  const answerResponse = { answers: response.answers }
  if (!isQuestionResponse(answerResponse)) {
    return {
      success: false,
      accepted: false,
      taskId,
      runtime: 'kcoder',
      code: 'interaction_answer_conflict',
      error: 'question or approval answer structure is invalid',
    }
  }
  const answers = answerResponse.answers
  // Keep foreign answer items from consuming the original question or leaving
  // its card awaiting a receipt for input the Gateway cannot accept.
  if (Array.isArray(pending.renderPayload.questions)) {
    const ids = new Set(pending.renderPayload.questions.map(question => record(question).id))
    if (Object.keys(answers).some(id => !ids.has(id))) {
      return {
        success: false,
        accepted: false,
        taskId,
        runtime: 'kcoder',
        code: 'interaction_answer_conflict',
        error: 'answer item identity does not belong to the original question',
      }
    }
  }
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
        subtaskId: pending.presentationSubtaskId ?? pending.turnId,
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
