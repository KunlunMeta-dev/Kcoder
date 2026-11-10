import { readTurnReceipt } from '../../../../../shared/turnReceipt'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './core'

const RECEIPT_CHECK_INTERVAL_MS = 15_000

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
  core.turnReceiptObservers.set(taskId, controller)
  const current = () => !controller.signal.aborted && !core.disposed &&
    core.accountEpochByTarget.get(task.serverId) === epoch &&
    core.clientByTask.get(taskId) === client &&
    core.activeTurnByTask.get(taskId) === active
  const stop = () => controller.abort()
  client.addEventListener('close', stop, { once: true })
  void active.completion.then(stop)

  void (async () => {
    try {
      while (current()) {
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(done, RECEIPT_CHECK_INTERVAL_MS)
          controller.signal.addEventListener('abort', done, { once: true })
        })
        if (!current()) return
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
          if (core.disposed || core.accountEpochByTarget.get(task.serverId) !== epoch ||
            core.clientByTask.get(taskId) !== client) return
          // The pane reads saved content and terminal state from its original task.
          window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', {
            detail: { taskId, deviceId: task.serverId },
          }))
          return
        } catch {
          // A failed or missing receipt says nothing about execution. Keep observing.
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
