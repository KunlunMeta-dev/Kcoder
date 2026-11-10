import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { isAsyncQuestionAnswerValue } from '../../../../../shared/generated/contractGuards.mjs'
import { captureAccountContextRevision } from '../../accountContextEvents'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

const METHODS = new Set(['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel'])
const CAPABILITY_ASYNC_USER_QUESTIONS_V1 = 'asyncUserQuestionsV1'

type AsyncQuestionOwner = Awaited<ReturnType<GatewayRuntimeCore['taskDescriptor']>> & {
  client: GatewayClient
  connectionId: string | undefined
  assertCurrent: () => Promise<void>
  assertBindingCurrent: () => void
}

async function resolveOwner(
  runtime: GatewayRuntimeCore,
  taskIdValue: unknown,
  workspacePathValue: unknown,
  deviceIdValue: unknown
): Promise<AsyncQuestionOwner> {
  const taskId = text(taskIdValue)
  if (!taskId) throw new Error('An asynchronous question task is required')
  const accountIsCurrent = captureAccountContextRevision()
  // The descriptor itself awaits the server directory and exposes a mutable
  // task entry. Resolve index aliases before freezing a known card's address.
  // Otherwise an in-place rebind during directory lookup becomes its new owner.
  const knownTask = runtime.tasks.get(runtime.resolveTaskId(taskId) ?? taskId)
  const originalTask = knownTask ? { ...knownTask } : undefined
  const owner = await runtime.taskDescriptor({ taskId })
  const { server } = owner
  // taskDescriptor returns a mutable map entry. Keep the original scalar
  // binding across readiness and receipt waits, including in-place rebinding.
  const task = { ...owner.task }
  const expected = originalTask ?? task
  if (runtime.resolveTaskId(taskId) !== owner.taskId ||
      ![task, runtime.tasks.get(owner.taskId)].every(current => current &&
      current.taskId === expected.taskId && current.serverId === expected.serverId &&
      current.threadId === expected.threadId && sameWorkspacePath(current.workspacePath, expected.workspacePath))) {
    throw new Error('Asynchronous question task ownership changed')
  }
  // A new directory refresh suspends dispatch even before it discovers whether
  // this target changed. Fence the gaps after awaited target checks as well.
  const directoryRefresh = runtime.commandDirectoryRefresh?.get(undefined)
  const targetRefresh = runtime.commandDirectoryRefresh?.get(task.serverId)
  // A displayed card can outlive a workspace rebind under the same task ID.
  // Compare its original address before preparing a replacement connection.
  if (workspacePathValue != null &&
      (typeof workspacePathValue !== 'string' || !workspacePathValue.trim() ||
        !sameWorkspacePath(workspacePathValue, task.workspacePath))) {
    throw new Error('Asynchronous question task ownership changed')
  }
  // A rendered card can predate alias/target remapping. Its original target
  // must agree before preparing a connection, even if thread and path match.
  if (deviceIdValue !== undefined && deviceIdValue !== task.serverId) {
    throw new Error('Asynchronous question task ownership changed')
  }
  const client = await runtime.readyTaskClient(task)
  const connectionId = client.diagnosticConnection?.connectionId
  const assertBindingCurrent = () => {
    const current = runtime.tasks.get(owner.taskId)
    if (
      runtime.disposed ||
      runtime.resolveTaskId(taskId) !== owner.taskId ||
      runtime.commandDirectoryRefresh?.get(undefined) !== directoryRefresh ||
      runtime.commandDirectoryRefresh?.get(task.serverId) !== targetRefresh ||
      !accountIsCurrent(server.id) ||
      !current ||
      current.taskId !== owner.taskId ||
      current.serverId !== task.serverId ||
      current.serverId !== server.id ||
      current.threadId !== task.threadId ||
      !sameWorkspacePath(current.workspacePath, task.workspacePath) ||
      runtime.clientByTask.get(owner.taskId) !== client ||
      runtime.appServerDisconnectedClients.has(client) ||
      client.diagnosticConnection?.connectionId !== connectionId
    ) {
      throw new Error('Asynchronous question task ownership changed')
    }
  }
  const assertCurrent = async () => {
    await runtime.assertCommandTarget(server)
    assertBindingCurrent()
  }
  await assertCurrent()
  return { ...owner, task, client, connectionId, assertCurrent, assertBindingCurrent }
}

export async function supportsAsyncQuestions(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const owner = await resolveOwner(this, params.taskId, params.workspacePath, params.deviceId)
  // Awaiting the owner helper yields after its internal check. Recheck in this
  // continuation so a queued disconnect or task switch cannot reuse that owner.
  owner.assertBindingCurrent()
  return {
    taskId: owner.taskId,
    threadId: owner.task.threadId,
    supported: owner.client.supportsExperimental?.(CAPABILITY_ASYNC_USER_QUESTIONS_V1) === true,
  }
}

function matchesAnswerPayload(submittedValue: unknown, savedValue: unknown): boolean {
  const submitted = record(submittedValue)
  const saved = record(savedValue)
  const submittedIds = Object.keys(submitted).sort()
  const savedIds = Object.keys(saved).sort()
  if (
    submittedIds.length !== savedIds.length ||
    submittedIds.some((id, index) => id !== savedIds[index])
  )
    return false
  return submittedIds.every(id => {
    // Validate before applying defaults so malformed values cannot become a
    // matching empty answer or silently lose fields while confirming a receipt.
    const input = submitted[id]
    const answer = saved[id]
    if (!isAsyncQuestionAnswerValue(input) || !isAsyncQuestionAnswerValue(answer)) return false
    // Rust defaults omitted selections to an empty Vec and null text to None.
    // Selection order and text whitespace remain part of the durable payload.
    const inputOptions = input.selectedOptionIds === undefined ? [] : input.selectedOptionIds
    const savedOptions = answer.selectedOptionIds === undefined ? [] : answer.selectedOptionIds
    return (
      inputOptions.length === savedOptions.length &&
      inputOptions.every((option, index) => option === savedOptions[index]) &&
      (input.text ?? undefined) === (answer.text ?? undefined)
    )
  })
}

export async function requestAsyncQuestion(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const method = text(params.method)
  if (!method || !METHODS.has(method))
    throw new Error('Unsupported asynchronous question operation')
  // Capture the JSON input before task readiness or receipt waits. Later draft
  // edits cannot change which question is sent or which answer is confirmed.
  const input = JSON.parse(JSON.stringify(record(params.params))) as Record<string, unknown>
  const owner = await resolveOwner(this, params.taskId, params.workspacePath, params.deviceId)
  owner.assertBindingCurrent()
  if (owner.client.supportsExperimental?.(CAPABILITY_ASYNC_USER_QUESTIONS_V1) !== true) {
    throw new Error('The selected task target does not support asynchronous questions')
  }

  // Only omission may use the resolved task; never repair an explicit binding.
  if (input.threadId !== undefined && input.threadId !== owner.task.threadId) {
    throw new Error('Asynchronous question task ownership changed')
  }
  const wireParams: Record<string, unknown> = { threadId: owner.task.threadId }
  if (method === 'asyncQuestion/list') {
    wireParams.includeTerminal = true
  } else {
    const questionId = text(input.questionId)
    const expectedRevision = input.expectedRevision
    if (!questionId || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) {
      throw new Error('Asynchronous question identity or revision is invalid')
    }
    wireParams.questionId = questionId
    wireParams.expectedRevision = expectedRevision
    if (method === 'asyncQuestion/answer') {
      const submissionId = text(input.submissionId)
      const answers = record(input.answers)
      if (
        !submissionId ||
        Object.keys(answers).length === 0 ||
        !Object.values(answers).every(isAsyncQuestionAnswerValue)
      ) {
        throw new Error('Asynchronous question answer is incomplete')
      }
      wireParams.submissionId = submissionId
      wireParams.answers = answers
    }
  }

  // Turn execution is projected exclusively by the standard task events and
  // resume snapshots. A saved answer is not evidence that its turn is still running.
  // The same client object can reconnect. Dispatch on the connection whose
  // task ownership was checked, without reopening a socket for stale input.
  const result = record(await (owner.connectionId && owner.client.requestOnConnection
    ? owner.client.requestOnConnection(owner.connectionId, method, wireParams)
    : owner.client.request(method, wireParams)))
  await owner.assertCurrent()
  // The async target check has its own completion microtask. Apply receipts
  // only while the binding is still current in this continuation.
  owner.assertBindingCurrent()
  if (result.threadId !== owner.task.threadId) {
    throw new Error('Asynchronous question response belongs to another task')
  }
  if (method === 'asyncQuestion/list') {
    const questions = Array.isArray(result.questions) ? result.questions : null
    if (!questions || questions.some(value => record(value).threadId !== owner.task.threadId)) {
      throw new Error('Asynchronous question list belongs to another task')
    }
  } else {
    const question = record(result.question)
    if (question.threadId !== owner.task.threadId || question.questionId !== input.questionId) {
      throw new Error('Asynchronous question response belongs to another task')
    }
    if (method === 'asyncQuestion/answer') {
      // Confirm the saved answer before returning its receipt to the card.
      if (typeof result.accepted !== 'boolean' || typeof result.duplicate !== 'boolean') {
        throw new Error('Invalid asynchronous question answer receipt')
      }
      if (
        result.accepted === true &&
        (record(question.answer).submissionId !== wireParams.submissionId ||
          !matchesAnswerPayload(wireParams.answers, record(question.answer).answers))
      ) {
        throw new Error(
          'Asynchronous question answer receipt does not match the submitted answer or submission'
        )
      }
      const startedTurn = record(result.startedTurn)
      // Legacy transports may bypass the Gateway's canonical identity check.
      if (result.startedTurn != null &&
          (typeof startedTurn.id !== 'string' || !startedTurn.id.trim())) {
        throw new Error('Asynchronous question started turn identity is invalid')
      }
      // Older Gateways may forward the target receipt without this binding
      // check. An explicit nested task must agree before any state is applied.
      if (startedTurn.threadId !== undefined && startedTurn.threadId !== owner.task.threadId) {
        throw new Error('Asynchronous question started turn belongs to another task')
      }
      // Older Gateways can forward conflicting compatibility identities.
      // Reject conflicting identities before confirming the saved answer.
      if (startedTurn.turnId !== undefined && startedTurn.turnId !== startedTurn.id) {
        throw new Error('Asynchronous question started turn identity mismatch')
      }
    }
  }
  return result
}
