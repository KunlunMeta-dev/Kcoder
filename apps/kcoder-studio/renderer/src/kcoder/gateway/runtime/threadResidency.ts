import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { isThreadEvictedParams, isThreadNotResidentErrorDataV1 } from '../../../../../shared/generated/contractGuards.mjs'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { GatewayRpcError } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './core'
import { record, text } from './contracts'

/**
 * Resident-thread eviction (`threadResidencyV1`).
 *
 * The app-server keeps a bounded number of resident threads per workspace and
 * evicts the least recently used idle one. The thread still exists; its task
 * connection only has to `thread/resume` it again. That re-activation happens
 * on the SAME task connection, so attachments and resources owned by that
 * connection stay valid for the retried request.
 */
export const THREAD_NOT_RESIDENT = -32027
export const THREAD_MAINTENANCE_BUSY = -32028

interface TaskIdentity {
  taskId: string
  threadId: string
  serverId: string
  workspacePath?: string | null
}

interface ThreadResidency {
  connectionId: string | undefined
  evicted: boolean
  notice: number
  restored: number
  pending?: Promise<void>
  lastAttempt?: { notice: number; result: Promise<void> }
}

const residencyByClient = new WeakMap<GatewayClient, Map<string, ThreadResidency>>()

function residency(client: GatewayClient, threadId: string) {
  let threads = residencyByClient.get(client)
  if (!threads) residencyByClient.set(client, (threads = new Map()))
  const connectionId = client.diagnosticConnection?.connectionId
  let current = threads.get(threadId)
  if (!current || current.connectionId !== connectionId) {
    current = { connectionId, evicted: false, notice: 0, restored: 0 }
    threads.set(threadId, current)
  }
  return current
}

export function isThreadNotResident(error: unknown, threadId: string, targetId?: string): boolean {
  return error instanceof GatewayRpcError &&
    error.reason === 'remote' && error.code === THREAD_NOT_RESIDENT &&
    (!targetId || !error.targetId || error.targetId === targetId) &&
    isThreadNotResidentErrorDataV1(error.data) && error.data.threadId === threadId
}

export function isThreadMaintenanceBusy(error: unknown): boolean {
  return error instanceof GatewayRpcError && error.code === THREAD_MAINTENANCE_BUSY
}

/** Remember that `threadId` is no longer resident behind this connection. */
export function markThreadEvicted(client: GatewayClient, threadId: string) {
  residency(client, threadId).evicted = true
}

export function isThreadEvicted(client: GatewayClient, threadId: string): boolean {
  const state = residencyByClient.get(client)?.get(threadId)
  return state?.evicted === true && state.connectionId === client.diagnosticConnection?.connectionId
}

/** `thread/evicted` from a task connection: re-activation is deferred to its next request. */
export function observeThreadEvicted(params: Record<string, unknown>, sourceClient?: GatewayClient) {
  if (sourceClient?.supportsExperimental?.('threadResidencyV1') !== true ||
      !isThreadEvictedParams(params)) return
  const state = residency(sourceClient, params.threadId)
  state.evicted = true
  state.notice += 1
}

export function captureResidencyOwner(
  runtime: GatewayRuntimeCore,
  task: TaskIdentity,
  client: GatewayClient
): () => void {
  const { taskId, threadId, serverId, workspacePath } = task
  const accountCurrent = captureAccountContextRevision()
  const targetEpoch = runtime.configurationEpochByTarget?.get(serverId)
  const connectionId = client.diagnosticConnection?.connectionId
  return () => {
    const current = runtime.tasks.get(taskId)
    if (runtime.disposed || !accountCurrent(serverId) ||
        runtime.configurationEpochByTarget?.get(serverId) !== targetEpoch ||
        runtime.clientByTask.get(taskId) !== client || runtime.disconnectRecoveryByTask?.has(taskId) ||
        runtime.appServerDisconnectedClients?.has(client) ||
        client.diagnosticConnection?.connectionId !== connectionId ||
        current?.threadId !== threadId || current.taskId !== taskId || current.serverId !== serverId ||
        !sameWorkspacePath(current.workspacePath, workspacePath))
      throw new Error('KCoder task ownership changed during residency recovery')
  }
}

/**
 * Resume an evicted thread on its current task connection. Concurrent callers
 * share one `thread/resume`; the task binding is re-checked after the await so
 * a replaced connection or task cannot adopt the result.
 */
export async function reactivateEvictedThread(
  runtime: GatewayRuntimeCore,
  task: TaskIdentity,
  client: GatewayClient
): Promise<void> {
  const assertCurrent = captureResidencyOwner(runtime, task, client)
  assertCurrent()
  const { threadId } = task
  const state = residency(client, threadId)
  if (!state.pending) {
    const notice = state.notice
    const params = { threadId }
    const run = (async () => {
      const result = state.connectionId && client.requestOnConnection
        ? await client.requestOnConnection<{ thread?: unknown }>(state.connectionId, 'thread/resume', params)
        : await client.request<{ thread?: unknown }>('thread/resume', params)
      if (text(record(result?.thread).id) !== threadId)
        throw new Error('KCoder app-server 恢复了错误的 thread')
      assertCurrent()
      // A new eviction observed while this resume was pending is a separate fact.
      if (state.notice === notice) state.evicted = false
      state.restored += 1
    })()
    state.pending = run
    state.lastAttempt = { notice, result: run }
    const settle = () => { if (state.pending === run) state.pending = undefined }
    run.then(settle, settle)
  }
  await state.pending
  assertCurrent()
}

/**
 * Run one thread-scoped request on the task connection. A typed not-resident
 * rejection for this exact thread precedes admission and side effects.
 * Resend it once, with the original parameters, after reactivation.
 */
export async function requestResidentTask<T>(
  runtime: GatewayRuntimeCore,
  task: TaskIdentity,
  client: GatewayClient,
  send: (client: GatewayClient) => Promise<T>,
  options: { retry: boolean; signal?: AbortSignal; assertCurrent?: () => void }
): Promise<T> {
  const assertOwner = captureResidencyOwner(runtime, task, client)
  const assertCurrent = () => {
    options.signal?.throwIfAborted()
    options.assertCurrent?.()
    assertOwner()
  }
  const sendCurrent = async () => {
    assertCurrent()
    const result = await send(client)
    assertCurrent()
    return result
  }
  const recoverable = (error: unknown) =>
    client.supportsExperimental?.('threadResidencyV1') === true &&
    isThreadNotResident(error, task.threadId, task.serverId)
  const state = residency(client, task.threadId)
  const observedResume = state.restored
  const observedAttempt = state.lastAttempt
  try {
    return await sendCurrent()
  } catch (error) {
    if (!recoverable(error)) throw error
    assertCurrent()
    // A late refusal from before another request's successful resume does not
    // need a second resume. The original call is still safe to send once.
    if (state.restored === observedResume) state.evicted = true
    if (!options.retry) throw error
    if (state.evicted) {
      const attempt = state.lastAttempt
      // Concurrent requests share a restore failure as well as success. A
      // new call or a new eviction observation can try recovery again.
      if (attempt && attempt !== observedAttempt && attempt.notice === state.notice)
        await attempt.result
      else
        await reactivateEvictedThread(runtime, task, client)
    }
    try {
      return await sendCurrent()
    } catch (retryError) {
      if (recoverable(retryError)) {
        assertCurrent()
        state.evicted = true
        state.notice += 1
      }
      throw retryError
    }
  }
}

export function requestResidentTaskRpc<T>(
  runtime: GatewayRuntimeCore,
  task: TaskIdentity,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; assertCurrent?: () => void }
): Promise<T> {
  const wire = { ...params, threadId: task.threadId }
  const connectionId = client.diagnosticConnection?.connectionId
  const args: [string, Record<string, unknown>, { signal: AbortSignal }?] = options?.signal
    ? [method, wire, { signal: options.signal }]
    : [method, wire]
  return requestResidentTask(runtime, task, client, current =>
    connectionId && current.requestOnConnection
      ? current.requestOnConnection<T>(connectionId, ...args)
      : current.request<T>(...args),
  { retry: true, ...options })
}
