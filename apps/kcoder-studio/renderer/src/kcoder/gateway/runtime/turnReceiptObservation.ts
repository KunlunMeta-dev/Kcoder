import { readTurnReceipt } from '../../../../../shared/turnReceipt'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './core'

const RECEIPT_CHECK_INTERVAL_MS = 15_000

/** Only accepted output from the current task connection can defer a receipt read. */
export function noteAcceptedTurnOutput(
  core: GatewayRuntimeCore,
  taskId: string,
  turnId: string,
  serverId?: string,
  client?: GatewayClient,
  attemptId?: string | null
): void {
  const active = core.activeTurnByTask.get(taskId)
  const task = core.tasks.get(taskId)
  const attempt = core.turnAttemptIds.get(`${taskId}:${turnId}`)
  if (!active || active.turnId !== turnId || !task || !client ||
    task.serverId !== serverId || core.clientByTask.get(taskId) !== client ||
    (attempt && attemptId && attempt !== attemptId)) return
  active.lastOutputAt = performance.now()
}

/** Reconcile a lost terminal notification without replaying the accepted input. */
export function observeAcceptedTurnReceipt(
  core: GatewayRuntimeCore,
  taskId: string,
  turnId: string,
  client: GatewayClient,
  identity: { threadId: string; clientMessageId?: string; retryOperationId?: string }
): void {
  core.turnReceiptObservers.get(taskId)?.abort()
  core.turnReceiptObservers.delete(taskId)
  const active = core.activeTurnByTask.get(taskId)
  const task = core.tasks.get(taskId)
  if (!active || active.turnId !== turnId || !task ||
    (!identity.clientMessageId && !identity.retryOperationId) ||
    client.supportsExperimental?.('turnReceiptsV1') !== true) return

  const controller = new AbortController()
  const epoch = core.accountEpochByTarget.get(task.serverId)
  const configuration = core.configurationEpochByTarget.get(task.serverId)
  const connection = client.diagnosticConnection?.connectionId
  core.turnReceiptObservers.set(taskId, controller)
  const ownsConnection = () => !core.disposed &&
    core.accountEpochByTarget.get(task.serverId) === epoch &&
    core.configurationEpochByTarget.get(task.serverId) === configuration &&
    client.diagnosticConnection?.connectionId === connection &&
    core.clientByTask.get(taskId) === client
  const current = () => !controller.signal.aborted && ownsConnection() &&
    core.activeTurnByTask.get(taskId) === active
  const stop = () => controller.abort()
  client.addEventListener('close', stop, { once: true })
  void active.completion.then(stop)

  void (async () => {
    let checkedAt = performance.now()
    const quietFor = () => performance.now() - Math.max(checkedAt, active.lastOutputAt ?? checkedAt)
    try {
      while (current()) {
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(done, Math.max(0, RECEIPT_CHECK_INTERVAL_MS - quietFor()))
          controller.signal.addEventListener('abort', done, { once: true })
        })
        if (!current()) return
        if (quietFor() < RECEIPT_CHECK_INTERVAL_MS) continue
        try {
          const response = await readTurnReceipt({
            supportsExperimental: capability => client.supportsExperimental?.(capability) === true,
            request: (method, params) => client.request(method, params, { signal: controller.signal }),
          }, identity)
          if (!current()) return
          const receipt = response.turn
          const attempt = core.turnAttemptIds.get(`${taskId}:${turnId}`)
          if (!receipt || receipt.id !== turnId || receipt.status === 'running' ||
            (attempt && receipt.attemptId !== attempt)) continue
          const status = receipt.status
          if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') continue
          const latest = core.tasks.get(taskId)
          if (!latest || latest.threadId !== identity.threadId) return
          // Reuse terminal projection/cleanup with the authoritative receipt;
          // this does not manufacture a wire event or an execution acknowledgement.
          await core.forwardAcceptedNotification('turn/completed', {
            threadId: identity.threadId,
            turn: { id: turnId, status, attemptId: receipt.attemptId },
          }, task.serverId, client)
          if (!ownsConnection()) return
          // The pane reads saved content and terminal state from its original task.
          window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', {
            detail: { taskId, deviceId: task.serverId },
          }))
          return
        } catch {
          // A failed or missing receipt says nothing about execution. Keep observing.
        } finally {
          checkedAt = performance.now()
        }
      }
    } finally {
      controller.abort()
      client.removeEventListener('close', stop)
      if (core.turnReceiptObservers.get(taskId) === controller)
        core.turnReceiptObservers.delete(taskId)
    }
  })()
}
