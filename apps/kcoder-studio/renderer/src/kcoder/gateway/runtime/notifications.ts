import { observeTaskCompaction } from '../../taskCompactionStatus'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { sha256 } from '@noble/hashes/sha2.js'
import { observeThreadEvicted } from './threadResidency'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { isGatewayRpcId } from '../../gatewayRpc'
import { hasConflictingTurnIdentity } from '../../../../../shared/turnNotificationIdentity'
import { normalizeWebSources } from '../../../../../shared/webSources'
import { normalizeToolDisplayText } from '../../../../../shared/toolDisplayText'
import { isApprovalResponse, isAsyncQuestionAnswerRecord, isAsyncQuestionRecord, isAsyncQuestionStatus } from '../../../../../shared/generated/contractGuards.mjs'
import { allowedFields } from '../../../../../shared/generated/validator.mjs'
import { asyncQuestionUtf8Length, hasAsyncQuestionText, hasValidAsyncQuestionRevision, hasValidQuestionAnswers } from '../../../../../shared/asyncQuestionRecordValidation'
import { asyncQuestionRevisionFingerprint } from '../../../../../shared/asyncQuestionRevision'
import { projectTaskTurn } from './taskTurnProjection'
import { normalizeReviewEvidence } from '../../../../../shared/reviewEvidence'
import { publishCommittedWidget } from '../../widgetEvents'
import { sameAgentRun } from './agentRunConstraint'
import { acceptWidgetPreviewNotification } from '../../widgetPreviewEvents'
import { validateWidgetReference } from '../../widgetApi'
import { parseThreadGoalStatusObservation } from '../../threadGoalStatus'
import { computerUseConsent } from '../../computerUseConsent'
import { notifyRuntimeWorkChanged } from '../../runtimeWorkEvents'
import { toolObservationOutput } from '../../toolObservationOutput'
import { computerUseStates } from '../../computerUseState'
import i18n from '@/i18n'
import { normalizeTurnFileCapture } from '../../../../../shared/turnFileCapture'
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
  type PendingGatewayQuestion,
} from './contracts'
import type { GatewayRuntimeCore } from './core'
import { forwardTaskState } from './taskState'
import { settleSteerNotification } from './turnSteer'
import { visibleUserItem } from './userMessages'
import { isPeerAgentMessage } from '../../../../../shared/peerAgentMessage'
import { isCurrentInteractionTaskBinding, publishInteractionResolution } from './interactions'
import { releaseUnviewedTaskClient } from './sessionLifetime'
import { noteAcceptedTurnOutput } from './turnReceiptObservation'
import { parseEvolutionChanged, publishEvolutionChanged } from '../../evolution/evolutionEvents'

const questionReplayClientIds = new WeakMap<GatewayClient, number>()
let nextQuestionReplayClientId = 0

function questionReplayClientId(client: GatewayClient): number {
  let id = questionReplayClientIds.get(client)
  if (id === undefined) {
    id = ++nextQuestionReplayClientId
    questionReplayClientIds.set(client, id)
  }
  return id
}

function peerNotification(method: string, params: Record<string, unknown>) {
  const item = record(params.item)
  return (method === 'item/started' || method === 'item/completed') &&
    (isPeerAgentMessage(item) || isPeerAgentMessage(record(item.content ?? item.message)))
}

function ownsPeerNotification(runtime: GatewayRuntimeCore, params: Record<string, unknown>, serverId?: string, client?: GatewayClient) {
  const threadId = text(params.threadId)
  const taskId = serverId && threadId ? runtime.taskByThread.get(runtime.threadKey(serverId, threadId)) : undefined
  const task = taskId ? runtime.tasks.get(taskId) : undefined
  return !!task && !!client && task.serverId === serverId && task.threadId === threadId && runtime.clientByTask.get(taskId!) === client
}

function isStaleTaskNotification(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  serverId: string | undefined,
  client?: GatewayClient,
  connection?: DiagnosticConnection
) {
  if (connection !== undefined &&
    client?.diagnosticConnection?.connectionId !== connection.connectionId) return true
  // Every task projection shares the same client fence, including streams and
  // starts. A matching old socket identity does not make it the current client.
  if (!serverId || !client) return false
  const threadId = text(params.threadId) ?? text(record(params.thread).id)
  const taskId = threadId ? runtime.taskByThread.get(runtime.threadKey(serverId, threadId)) : undefined
  return taskId !== undefined && runtime.clientByTask.get(taskId) !== client
}

function matchesInteractionResolution(
  runtime: GatewayRuntimeCore,
  pending: PendingGatewayQuestion,
  params: Record<string, unknown>,
  sourceClient?: GatewayClient
) {
  return pending.requestId === params.requestId && pending.turnId === text(params.turnId) &&
    // Legacy omission is compatible only with another omitted/null epoch.
    (pending.appServerEpoch ?? null) === (params.appServerEpoch ?? null) &&
    (sourceClient === undefined || pending.client === sourceClient) &&
    runtime.clientByTask.get(pending.taskId) === pending.client &&
    isCurrentInteractionTaskBinding(runtime, pending)
}

export async function forwardNotification(
  this: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>,
  sourceServerId?: string,
  sourceClient?: GatewayClient,
  diagnosticConnection?: DiagnosticConnection
) {
  if (this.disposed || hasConflictingTurnIdentity({ method, params })) return
  if (method === 'evolution/changed') {
    // Target-scoped refetch hint; it carries no task identity or replay ID.
    const event = parseEvolutionChanged(sourceServerId, params)
    if (event) publishEvolutionChanged(event)
    return
  }
  if (method === 'thread/evicted') {
    // The thread still exists; its next request resumes it on this connection.
    const threadId = text(params.threadId)
    const taskId = threadId && sourceServerId
      ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
      : undefined
    if (taskId && sourceClient && this.clientByTask.get(taskId) === sourceClient &&
        !isStaleTaskNotification(this, params, sourceServerId, sourceClient, diagnosticConnection))
      observeThreadEvicted(params, sourceClient)
    return
  }
  // Legacy transports can bypass the Gateway's terminal-outcome validation.
  // Invalid outcomes must not close a card or claim its recovery replay ID.
  if ((method === 'question/resolved' || method === 'approval/resolved') &&
      (typeof params.reason !== 'string' || !hasAsyncQuestionText(params.reason) || /\p{Surrogate}/u.test(params.reason) ||
        (method === 'approval/resolved' && params.decision !== undefined &&
          !isApprovalResponse({ decision: params.decision })))) return
  // Rejected old frames cannot consume a current client's replay identity.
  if (isStaleTaskNotification(this, params, sourceServerId, sourceClient, diagnosticConnection)) return
  if (method === 'thread/maintenance') {
    observeTaskCompaction(this, params, sourceServerId, sourceClient)
    return
  }
  if (peerNotification(method, params) && !ownsPeerNotification(this, params, sourceServerId, sourceClient)) return
  if (method === 'thread/goal/updated' || method === 'thread/goal/continuation') {
    const threadId = text(params.threadId) ?? text(record(params.thread).id)
    const taskId = threadId && sourceServerId
      ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
      : undefined
    const task = taskId ? this.tasks.get(taskId) : undefined
    if (!task || !sourceClient || task.threadId !== threadId || task.serverId !== sourceServerId ||
        sourceClient !== this.clientByTask.get(task.taskId)) return
  }
  if (method.startsWith('agent/stream/')) {
    await this.forwardAcceptedNotification(
      method,
      params,
      sourceServerId,
      sourceClient,
      diagnosticConnection
    )
    return
  }
  // Replacement clients have separate ordered queues. A stale question must
  // finish owner validation before claiming the replay needed by its successor.
  const deferredReplay = method === 'asyncQuestion/changed'
  let replayScope = sourceServerId
  let replayParams = params
  if (!deferredReplay && !this.notificationReplayGuard.accept(method, params, replayScope)) return
  let replayClaimed = !deferredReplay
  try {
    const projected = await this.forwardAcceptedNotification(
      method,
      params,
      sourceServerId,
      sourceClient,
      diagnosticConnection,
      deferredReplay && sourceClient ? (replayIdentity) => {
        // Scope claims to the connection and durable content. A legacy hint or
        // a conflicting snapshot can share a sequence and still require readback.
        // Retain a fixed-size digest, including when the snapshot carries answers.
        // Clients without transport diagnostics still have an exact owner.
        const connection = diagnosticConnection?.connectionId ?? questionReplayClientId(sourceClient)
        replayScope = JSON.stringify([sourceServerId, connection,
          bytesToHex(sha256(utf8ToBytes(replayIdentity)))])
        // Legacy frames can omit the producer ID. The validated client scope
        // still lets the replay guard deduplicate them when a sequence exists.
        if (params.serverId === undefined) replayParams = { ...params, serverId: '' }
        replayClaimed = this.notificationReplayGuard.accept(method, replayParams, replayScope)
        return replayClaimed
      } : undefined
    )
    // A discarded question frame has not refreshed any card. Leave its native
    // event identity available for the current owner's recovery replay.
    if (projected === false && replayClaimed) this.notificationReplayGuard.release(method, replayParams, replayScope)
  } catch (error) {
    if (replayClaimed) this.notificationReplayGuard.release(method, replayParams, replayScope)
    throw error
  }
}

export async function forwardAcceptedNotification(
  this: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>,
  sourceServerId?: string,
  sourceClient?: GatewayClient,
  diagnosticConnection?: DiagnosticConnection,
  acceptQuestionReplay?: (identity: string) => boolean
) {
  if (hasConflictingTurnIdentity({ method, params })) return false
  if (isStaleTaskNotification(this, params, sourceServerId, sourceClient, diagnosticConnection)) return
  if (peerNotification(method, params) && !ownsPeerNotification(this, params, sourceServerId, sourceClient)) return false
  const questionThreadId = method === 'asyncQuestion/changed' ? text(params.threadId) : null
  const questionTaskId = questionThreadId && sourceServerId
    ? this.taskByThread.get(this.threadKey(sourceServerId, questionThreadId)) : undefined
  // Snapshot the path because the directory can rebind the same task entry.
  const questionWorkspace = questionTaskId ? this.tasks.get(questionTaskId)?.workspacePath : undefined
  if (await settleSteerNotification(this, method, params, sourceServerId, sourceClient)) return
  // Projection yields above. The same client can reconnect in that gap; the
  // discarded frame must leave its identity available for current recovery.
  if (isStaleTaskNotification(this, params, sourceServerId, sourceClient, diagnosticConnection)) {
    return false
  }
  if (method === 'gateway/interaction/replyRejected') {
    const threadId = text(params.threadId)
    const taskId = threadId && sourceServerId
      ? this.taskByThread.get(this.threadKey(sourceServerId, threadId)) : undefined
    const pending = taskId && isGatewayRpcId(params.requestId)
      ? this.pendingQuestionByKey.get(`${taskId}\0${params.requestId}`) : undefined
    if (!pending?.responsePending || pending.requestId !== params.requestId || !sourceClient || pending.client !== sourceClient ||
        this.clientByTask.get(pending.taskId) !== sourceClient ||
        this.appServerDisconnectedClients.has(sourceClient)) return false
    if (!isCurrentInteractionTaskBinding(this, pending)) return false
    const bound = ['turnId', 'appServerEpoch', 'questionId', 'approvalId']
      .some(key => Object.hasOwn(params, key))
    // Legacy Gateways name only the task and transport request. New bindings
    // must match completely, including epoch absence and interaction kind.
    if (bound && (pending.turnId !== params.turnId ||
        (pending.appServerEpoch ?? null) !== (params.appServerEpoch ?? null) ||
        (pending.approvalId
          ? pending.approvalId !== params.approvalId || params.questionId != null
          : pending.questionId !== params.questionId || params.approvalId != null))) return false
    // A later receipt may confirm another client's answer. The rejected local
    // answer must never become that receipt's confirmed presentation.
    delete pending.submittedResponse
    if (pending.autoResolutionTimer !== undefined) {
      window.clearTimeout(pending.autoResolutionTimer)
      delete pending.autoResolutionTimer
    }
    const explanation = i18n.t('workbench.runtime_send_failed')
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.updated',
      payload: {
        taskId: pending.taskId,
        subtaskId: pending.presentationSubtaskId ?? pending.turnId,
        turnId: pending.turnId,
        attemptId: pending.presentationSubtaskId ?? pending.turnId,
        deviceId: sourceServerId,
        data: {
          blockId: pending.block.id,
          updates: {
            status: 'error',
            renderPayload: pending.renderPayload,
            tool_output: explanation,
            toolOutput: explanation,
          },
        },
      },
    })
    // Keep the original submission guard until the rejection reaches the UI.
    // Failed publication can then retry without replaying the answer.
    pending.responsePending = false
    return
  }
  if (method === 'asyncQuestion/changed') {
    const threadId = questionThreadId
    const question = record(params.question)
    const questionId = question.questionId
    const revision = finiteNumber(question.revision, -1)
    const { status, answer, deliveryError } = question
    // Legacy hints can omit prompts, but their explicit source and answer
    // identities still need to be usable by State before claiming replay order.
    const validIdentifier = (value: unknown) => typeof value === 'string' && hasAsyncQuestionText(value) &&
      asyncQuestionUtf8Length(value) <= 256 && !/[\uD800-\uDFFF]/u.test(value)
    const completeQuestion = isAsyncQuestionRecord(question) && hasValidQuestionAnswers(question)
    if (
      this.disposed ||
      !sourceServerId ||
      !sourceClient ||
      // Older/direct transports may bypass the Gateway's strict envelope.
      // Reject unknown fields before a malformed hint claims replay order.
      Object.keys(params).some(field => field !== 'serverId' && field !== 'sequence' &&
        !allowedFields.AsyncQuestionChangedNotification.includes(field)) ||
      // Legacy hints may omit replay metadata. Reject unusable explicit
      // metadata before forwarding, since it cannot identify a valid replay.
      (params.sequence !== undefined && (!Number.isSafeInteger(params.sequence) ||
        Number(params.sequence) < 0)) ||
      (params.serverId !== undefined && (typeof params.serverId !== 'string' ||
        !hasAsyncQuestionText(params.serverId) || params.serverId.length > 256 ||
        /\p{Surrogate}/u.test(params.serverId))) ||
      // Disconnect is recorded before the ordered notification queue drains.
      // Queued changes cannot refresh cards through that invalid owner.
      this.appServerDisconnectedClients.has(sourceClient) ||
      !threadId ||
      question.threadId !== threadId ||
      !validIdentifier(questionId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      // Legacy hints may omit prompts, but unknown record fields still violate
      // the wire contract and cannot claim a corrected recovery event's sequence.
      Object.keys(question).some(field => !allowedFields.AsyncQuestionRecord.includes(field)) ||
      // Legacy hints may omit source locators, but explicit identities must
      // satisfy State's UTF-8 budget and Rust string contract before claiming
      // the replay sequence needed by a corrected original-task notification.
      ['requestId', 'sourceTurnId', 'toolCallId'].some(field =>
        question[field] !== undefined && !validIdentifier(question[field])) ||
      // Legacy status-only hints also claim a replay sequence. An invalid
      // explicit state cannot suppress the later original-task refresh.
      (status !== undefined && !isAsyncQuestionStatus(status)) ||
      !hasValidAsyncQuestionRevision({ status, revision, answer, deliveryError }) ||
      // Partial legacy snapshots still carry explicit wire metadata. Invalid
      // creation times must not consume a corrected event's replay sequence.
      (question.createdAtMs !== undefined && (!Number.isSafeInteger(question.createdAtMs) ||
        Number(question.createdAtMs) < 0)) ||
      // Legacy hints omit prompts but must retain State's delivery-error rules
      // before claiming the sequence needed by a corrected recovery event.
      (question.deliveryError != null && (typeof question.deliveryError !== 'string' ||
        /\p{Surrogate}/u.test(question.deliveryError) ||
        asyncQuestionUtf8Length(JSON.stringify(question.deliveryError)) > 2 * 1024 ||
        (question.status !== undefined && question.status !== 'delivery_failed' &&
          question.status !== 'delivery_unknown'))) ||
      // Partial legacy hints may still carry a saved answer. Invalid saved
      // data must leave the original event available for recovery readback.
      (question.answer != null && (!isAsyncQuestionAnswerRecord(question.answer) ||
        !validIdentifier(question.answer.submissionId) ||
        Object.keys(question.answer.answers).length < 1 || Object.keys(question.answer.answers).length > 8 ||
        Object.entries(question.answer.answers).some(([id, answer]) => {
          const selected = answer.selectedOptionIds ?? []
          return !validIdentifier(id) || selected.length > 16 ||
            new Set(selected).size !== selected.length || selected.some(id => !validIdentifier(id)) ||
            (selected.length === 0 && !hasAsyncQuestionText(answer.text ?? ''))
        }) ||
        // Match State's typed-map budget: omitted Vec fields become empty arrays,
        // null text is omitted, and JSON escaping still contributes bytes.
        asyncQuestionUtf8Length(JSON.stringify(Object.fromEntries(Object.entries(question.answer.answers).map(([id, answer]) =>
          [id, { selectedOptionIds: answer.selectedOptionIds ?? [],
            ...(answer.text == null ? {} : { text: answer.text }) }])))) > 16 * 1024)) ||
      // An explicit snapshot cannot fall back to a legacy refresh hint. Doing
      // so would consume the sequence needed by its valid recovery replay.
      (question.questions !== undefined && !completeQuestion) ||
      sourceClient.supportsExperimental?.('asyncUserQuestionsV1') !== true
    )
      return false
    const taskId = this.taskByThread.get(this.threadKey(sourceServerId, threadId))
    const task = taskId ? this.tasks.get(taskId) : undefined
    if (
      !task ||
      task.serverId !== sourceServerId ||
      task.threadId !== threadId ||
      (questionTaskId !== undefined && taskId !== questionTaskId) ||
      (questionWorkspace !== undefined && !sameWorkspacePath(task.workspacePath, questionWorkspace)) ||
      this.clientByTask.get(taskId!) !== sourceClient
    )
      return false
    const fingerprint = completeQuestion ? asyncQuestionRevisionFingerprint(question) : undefined
    // A corrected source can reuse the sequence and revision of a sparse hint.
    // Keep those bindings distinct without promoting a hint to a full snapshot.
    const replayIdentity = fingerprint ?? JSON.stringify([
      questionId, revision, question.requestId, question.sourceTurnId, question.toolCallId,
    ])
    if (acceptQuestionReplay && !acceptQuestionReplay(replayIdentity)) return false
    await emit(EXECUTOR_EVENT, {
      event: 'async-question:changed',
      payload: { taskId, serverId: sourceServerId, threadId, questionId, revision,
        ...(fingerprint === undefined ? {} : { revisionFingerprint: fingerprint }) },
    })
    return
  }
  if (method === 'integrations/runtime/taskStateChanged') {
    if (sourceServerId && sourceClient) await forwardTaskState(this, sourceServerId, sourceClient, params)
    return
  }
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
  if (
    method === 'agent/stream/event' ||
    method === 'agent/stream/reset' ||
    method === 'agent/stream/closed'
  ) {
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
    if (owned.expectedBackgroundRun) {
      const closed = method === 'agent/stream/closed'
      if (
        closed
          ? !sameAgentRun(params.expectedBackgroundRun, owned.expectedBackgroundRun)
          : params.runId !== owned.expectedBackgroundRun.runId
      ) {
        owned.removeCloseListener?.()
        this.agentConversationSubscriptions.delete(id!)
        void owned.client
          .request('agent/stream/unsubscribe', { subscriptionId: id })
          .catch(() => undefined)
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
              runId: owned.expectedBackgroundRun.runId,
              reason: 'agent_run_changed',
            },
          },
        })
        return
      }
      if (closed) {
        owned.removeCloseListener?.()
        this.agentConversationSubscriptions.delete(id!)
        void owned.client
          .request('agent/stream/unsubscribe', { subscriptionId: id })
          .catch(() => undefined)
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
              runId: owned.expectedBackgroundRun.runId,
              reason:
                params.reasonCode === 'run_changed'
                  ? 'agent_run_changed'
                  : 'agent_owner_unavailable',
            },
          },
        })
        return
      }
    } else if (method === 'agent/stream/closed') return
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
      isGatewayRpcId(params.requestId)
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
      !matchesInteractionResolution(this, pending, params, sourceClient) ||
      pending.approvalDecisions ||
      params.approvalId != null ||
      (pending.questionId && pending.questionId !== text(params.questionId))
    )
      return false
    if (pending.autoResolutionTimer !== undefined) window.clearTimeout(pending.autoResolutionTimer)
    const reason = text(params.reason) ?? 'cancelled'
    const status = reason === 'client_response' ? 'done' : 'error'
    const explanation =
      reason === 'response_error'
        ? '回答发送后未被服务端接受。'
        : reason === 'cancelled' || reason === 'client_cancelled'
          ? '问题请求已取消。'
          : reason === 'client_response'
            ? '回答已由服务端确认。'
            : i18n.t('workbench.runtime_send_failed')
    // Sending is provisional; only an accepted answer may become a summary.
    const response = reason === 'client_response' ? pending.submittedResponse : undefined
    const renderPayload = { ...pending.renderPayload, resolved: true, ...(response ? { response } : {}) }
    await publishInteractionResolution(this, pending, () => emit(EXECUTOR_EVENT, {
      event: 'response.block.updated',
      payload: {
        taskId: pending.taskId,
        subtaskId: pending.presentationSubtaskId ?? pending.turnId,
        turnId: pending.turnId,
        attemptId: pending.presentationSubtaskId ?? pending.turnId,
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
    }))
    return
  }
  if (method === 'approval/resolved') {
    const requestId =
      isGatewayRpcId(params.requestId)
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
    if (!pending || !pending.approvalId ||
        params.questionId != null ||
        !matchesInteractionResolution(this, pending, params, sourceClient) ||
        pending.approvalId !== text(params.approvalId)) return false
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
    await publishInteractionResolution(this, pending, () => emit(EXECUTOR_EVENT, {
      event: 'response.block.updated',
      payload: {
        taskId: pending.taskId,
        subtaskId: pending.presentationSubtaskId ?? pending.turnId,
        turnId: pending.turnId,
        attemptId: pending.presentationSubtaskId ?? pending.turnId,
        deviceId: sourceServerId,
        data: {
          blockId: pending.block.id,
          updates: {
            status,
            renderPayload: { ...pending.renderPayload, resolved: true },
            tool_output: explanation,
            toolOutput: explanation,
          },
        },
      },
    }))
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
  if (
    method !== 'computerUse/stateChanged' &&
    sourceServerId &&
    sourceClient &&
    this.toolPathPreviews.beforeResumeBoundary(params, sourceServerId, taskId, sourceClient)
  )
    return
  const turnId = text(params.turnId) ?? text(turn.id) ?? 'kcoder-turn'
  const turnKey = `${taskId}:${turnId}`
  const currentAttempt = this.turnAttemptIds.get(turnKey)
  // Preserve the exact attempt after lifecycle validation; JS trim would erase
  // U+FEFF and let a stale terminal masquerade as an omitted legacy identity.
  const terminalAttempt = rawDeltaText(params.attemptId) ?? rawDeltaText(turn.attemptId)
  // A late terminal from an earlier continuation must not consume the
  // current attempt's text, identity or running state.
  if (
    method === 'turn/completed' &&
    currentAttempt &&
    terminalAttempt &&
    currentAttempt !== terminalAttempt
  )
    return
  const completedAttemptKey = `${turnKey}\0${rawDeltaText(params.serverId) ?? ''}\0${terminalAttempt ?? currentAttempt ?? turnId}`
  // A first delayed start is not an exact-frame replay. Once this attempt has
  // ended, it cannot replace a retry or reopen its question/approval lifecycle.
  if (method === 'turn/started' && terminalAttempt &&
      this.completedTurnAttemptKeys.has(completedAttemptKey)) return
  if (method === 'turn/started')
    this.turnAttemptIds.set(turnKey, terminalAttempt ?? turnId)
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
    displayText: normalizeToolDisplayText(params.displayText),
    ...(Number.isSafeInteger(params.occurredAtMs) && Number(params.occurredAtMs) > 0 &&
      Number(params.occurredAtMs) <= 8_640_000_000_000_000
      ? { occurredAtMs: Number(params.occurredAtMs) } : {}),
    taskId,
    subtaskId: this.turnAttemptIds.get(turnKey) ?? turnId,
    turnId,
    attemptId: this.turnAttemptIds.get(turnKey) ?? undefined,
    deviceId: task?.serverId ?? (await this.server()).id,
  }
  if (
    task &&
    sourceServerId === task.serverId &&
    sourceClient === this.clientByTask.get(taskId) &&
    sourceClient?.supportsExperimental?.('inlineWidgetsV1') === true
  ) {
    const acceptedAttempt = this.turnAttemptIds.get(turnKey) ?? turnId
    const suppliedAttempt = text(params.attemptId) ?? text(turn.attemptId)
    if (suppliedAttempt === acceptedAttempt && threadId)
      acceptWidgetPreviewNotification(
        {
          deviceId: sourceServerId,
          taskId,
          threadId,
          turnId,
          attemptId: acceptedAttempt,
          client: sourceClient,
          serverId: params.serverId,
          sequence: params.sequence,
        },
        method,
        params.event
      )
  }
  if (method === 'computerUse/stateChanged') {
    const activeTurnId = this.activeTurnByTask.get(taskId)?.turnId
    const lateSettlement =
      task !== undefined &&
      activeTurnId === undefined &&
      computerUseStates.isLatestTurn(this, task.serverId, taskId, turnId) &&
      ['stopping', 'stop_failed', 'stopped'].includes(String(params.state))
    if (
      task &&
      sourceServerId === task.serverId &&
      sourceClient === this.clientByTask.get(taskId) &&
      (activeTurnId === turnId || lateSettlement)
    ) {
      computerUseStates.apply(
        this,
        task.serverId,
        taskId,
        turnId,
        params,
        diagnosticConnection?.connectionId ?? sourceClient
      )
      if (['revoked', 'unknown'].includes(String(record(params.diagnostic).authorization)))
        computerUseConsent.set(task.serverId, taskId, false)
    }
    return
  }
  if (method === 'thread/goal/updated' || method === 'thread/goal/continuation') {
    if (!task || !sourceClient || threadId !== task.threadId ||
        sourceServerId !== task.serverId || sourceClient !== this.clientByTask.get(taskId)) return
    if (method === 'thread/goal/updated') {
      const goal = record(params.goal)
      const observed = params.goal === null
        ? { availability: 'available' as const, status: null }
        : text(goal.threadId) === threadId
          ? parseThreadGoalStatusObservation({ availability: 'available', status: goal.status })
          : { availability: 'unavailable' as const }
      // Goal notifications reflect in-memory state, which may not have persisted.
      // A completion or cleared Goal needs a verified read before the board can
      // treat the latest completed turn as a completed task.
      const observation = observed.availability === 'available' &&
        (observed.status === 'complete' || observed.status === null)
        ? { availability: 'unavailable' as const }
        : observed
      this.tasks.set(taskId, {
        ...task,
        goalStatusObservation: observation,
        goalStatus: observation.availability === 'available' ? observation.status : undefined,
      })
      const previous = task.goalStatusObservation
      // Usage snapshots update the pane, not the task index. Completion and
      // clearance still require a durable read even after an unknown snapshot.
      if (!previous || previous.availability !== observation.availability ||
          (previous.availability === 'available' && observation.availability === 'available' &&
            previous.status !== observation.status) ||
          (observed.availability === 'available' && (observed.status === 'complete' || observed.status === null)))
        notifyRuntimeWorkChanged()
      if (observed.availability === 'unavailable') return
    }
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
    const attemptId = terminalAttempt
    if (
      task &&
      sourceServerId === task.serverId &&
      sourceClient &&
      sourceClient === this.clientByTask.get(taskId)
    ) {
      computerUseStates.noteTurnStarted(
        this,
        task.serverId,
        taskId,
        turnId,
        attemptId ?? undefined
      )
    }
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
        params.sequence,
        diagnosticConnection?.connectionId ?? sourceClient
      )
    }
    if (this.activeTurnByTask.get(taskId)?.turnId !== turnId) {
      this.trackActiveTurn(taskId, turnId, turn.internal === true)
    }
    if (task) {
      let runtimeHandle = task.runtimeHandle
      const serverInstanceId = text(params.serverId)
      if (
        sourceServerId === task.serverId &&
        sourceClient === this.clientByTask.get(taskId) &&
        threadId === task.threadId &&
        attemptId &&
        serverInstanceId &&
        Number.isSafeInteger(params.sequence) &&
        (params.sequence as number) >= 0
      ) {
        const previous = runtimeHandle.memoryTaskSnapshot
        const retired = previous?.retiredServerInstances ?? []
        if (
          !retired.includes(serverInstanceId) &&
          (!previous ||
            previous.serverInstanceId !== serverInstanceId ||
            (params.sequence as number) > previous.sequence)
        ) {
          const id = text(
            Object.hasOwn(turn, 'memorySnapshotId')
              ? turn.memorySnapshotId
              : params.memorySnapshotId
          )
          runtimeHandle = {
            ...runtimeHandle,
            memoryTaskSnapshot: {
              snapshotId: id && id.length <= 256 ? id : null,
              threadId,
              turnId,
              attemptId,
              serverInstanceId,
              retiredServerInstances:
                previous && previous.serverInstanceId !== serverInstanceId
                  ? [...retired, previous.serverInstanceId].slice(-64)
                  : retired,
              sequence: params.sequence as number,
            },
          }
        }
      }
      this.tasks.set(taskId, { ...projectTaskTurn(task, 'inProgress'), runtimeHandle })
      // The sidebar also needs an invalidation when a peer starts this turn.
      // A memory snapshot is optional and is not evidence of a state change.
      notifyRuntimeWorkChanged()
    }
    if (this.turnText.get(turnKey) !== null || currentAttempt !== (attemptId ?? turnId)) {
      this.turnText.set(turnKey, '')
    }
    await emit(EXECUTOR_EVENT, { event: 'response.created', payload: { ...base, data: {} } })
    return
  }
  if (method === 'item/delta') {
    const delta = rawDeltaText(record(params.delta).text)
    if (delta === null || delta === '') return
    noteAcceptedTurnOutput(this, taskId, turnId, sourceServerId, sourceClient, terminalAttempt)
    const previousText = this.turnText.get(turnKey)
    if (previousText !== null) this.turnText.set(turnKey, `${previousText ?? ''}${delta}`)
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
    if (eventType === 'context_usage_updated') {
      const contextUsage = record(event.contextUsage)
      if (Object.keys(contextUsage).length === 0) return
      await emit(EXECUTOR_EVENT, {
        event: 'thread/tokenUsage/updated',
        payload: { ...base, data: { tokenUsage: contextUsage } },
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
      if (sourceClient) setTimeout(() => releaseUnviewedTaskClient(this, job.taskId, sourceClient), 0)
      return
    }
    if (eventType !== 'assistant_thinking_delta') return
    const delta = text(event.text)
    if (!delta) return
    noteAcceptedTurnOutput(this, taskId, turnId, sourceServerId, sourceClient, terminalAttempt)
    await emit(EXECUTOR_EVENT, {
      event: 'response.reasoning_summary_text.delta',
      payload: { ...base, data: { delta } },
    })
    return
  }
  if (peerNotification(method, params)) {
    if (!task || !sourceClient || sourceServerId !== task.serverId ||
        sourceClient !== this.clientByTask.get(taskId) || threadId !== task.threadId) return false
    const message = visibleUserItem(params.item)
    // The accumulated turn text spans both sides of this committed peer item.
    // Do not replace the final segment with that whole-turn string at completion.
    if (message && this.turnText.has(turnKey)) this.turnText.set(turnKey, null)
    if (message) await emit(EXECUTOR_EVENT, {
      event: 'runtime.user_message',
      payload: { ...base, data: { message: { ...message, turnId } } },
    })
    return
  }
  if (method === 'item/started') {
    const item = record(params.item)
    if (item.type === 'userMessage' || item.type === 'peerAgentMessage') {
      if (!task || !sourceClient || sourceServerId !== task.serverId ||
          sourceClient !== this.clientByTask.get(taskId) || threadId !== task.threadId) return
      const message = visibleUserItem(item)
      if (message) await emit(EXECUTOR_EVENT, {
        event: 'runtime.user_message',
        payload: { ...base, data: { message: { ...message, turnId } } },
      })
      return
    }
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
    if (
      item.widgetRef &&
      item.status !== 'failed' &&
      threadId &&
      task &&
      sourceServerId === task.serverId &&
      sourceClient === this.clientByTask.get(taskId)
    ) {
      try {
        const widget = validateWidgetReference(item.widgetRef, threadId ?? undefined)
        if (
          widget.turnId === turnId &&
          widget.attemptId === (this.turnAttemptIds.get(turnKey) ?? turnId) &&
          widget.attemptId === (text(params.attemptId) ?? text(turn.attemptId)) &&
          widget.toolCallId === callId
        )
          publishCommittedWidget({ deviceId: sourceServerId, taskId, widget })
      } catch {
        // Invalid presentation metadata never becomes a trusted artifact.
      }
    }
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
            webSources:
              sourceServerId === task?.serverId && sourceClient === this.clientByTask.get(taskId) && callId
                ? normalizeWebSources(item.webSources, {
                    threadId: threadId ?? undefined,
                    turnId,
                    attemptId: this.turnAttemptIds.get(turnKey) ?? text(params.attemptId) ?? undefined,
                    toolCallId: callId,
                  })
                : undefined,
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
    this.completedTurnAttemptKeys.add(completedAttemptKey)
    if (this.completedTurnAttemptKeys.size > 512)
      this.completedTurnAttemptKeys.delete(this.completedTurnAttemptKeys.values().next().value!)
    const reviewEvidence = sourceClient?.supportsExperimental?.('turnReviewEvidenceV1') === true
      && sourceClient === this.clientByTask.get(taskId) && sourceServerId === task?.serverId
      ? normalizeReviewEvidence(params.reviewEvidence, { threadId: threadId ?? undefined, turnId, attemptId: base.attemptId ?? turnId })
      : undefined
    const fileCapture = sourceClient?.supportsExperimental?.('turnFileCaptureV1') === true
      && sourceClient === this.clientByTask.get(taskId) && sourceServerId === task?.serverId
      ? normalizeTurnFileCapture(params.fileChangesCapture, { threadId: threadId ?? undefined, turnId, attemptId: base.attemptId ?? turnId })
      : undefined
    if (task)
      computerUseStates.unconfirmed(
        this,
        task.serverId,
        taskId,
        turnId,
        true
      )
    const status = text(turn.status) ?? 'completed'
    const terminalError = text(record(params.error).message)
    const content = this.turnText.get(turnKey)
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
    if (task && (!active || active.turnId === turnId)) {
      const outcome = status === 'completed' || status === 'failed' || status === 'interrupted' ? status : undefined
      this.tasks.set(taskId, outcome
        ? projectTaskTurn(task, outcome, [...this.backgroundJobById.values()].some(job => job.taskId === taskId))
        : { ...task, running: false, updatedAt: Date.now() })
      notifyRuntimeWorkChanged()
    }
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
          ...(status === 'completed'
            ? (content === null ? {} : { value: content ?? '' })
            : { message: terminalError ?? status }),
          ...(status !== 'completed'
            ? { provider_failure: decodeProviderFailure(record(params.error).details) }
            : {}),
          turnId,
          turn_id: turnId,
          ...(fileCapture && { file_changes_capture: fileCapture }),
          ...(reviewEvidence && { review_evidence: reviewEvidence }),
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
    if (content === null && task) {
      // Deltas lost during disconnection cannot be reconstructed from this socket.
      await emit(EXECUTOR_EVENT, {
        event: 'executor.task_stream_gap',
        payload: { taskId, deviceId: task.serverId },
      })
    }
    // Receipt reconciliation still needs this client until its caller has
    // published the recovered terminal state and requested a transcript refresh.
    if (sourceClient) setTimeout(() => releaseUnviewedTaskClient(this, taskId, sourceClient), 0)
  }
}
