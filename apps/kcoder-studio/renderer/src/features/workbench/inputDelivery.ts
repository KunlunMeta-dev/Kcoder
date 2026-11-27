import type { RuntimeInputDelivery } from '@/types/api'
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
  RuntimePaneQueuedMessage,
} from '@/types/workbench'

export function isTerminalInput(status: RuntimePaneQueuedMessage['status']): boolean {
  return (
    status === 'applied' ||
    status === 'completed' ||
    status === 'interrupted' ||
    status === 'execution_failed'
  )
}

export function canSubmitInput(message: RuntimePaneQueuedMessage): boolean {
  return (
    !message.turnId &&
    !message.cancelRequested &&
    (message.status === 'queued' || message.status === 'failed')
  )
}

/** Steering has no per-input withdrawal operation; observe it before offering turn cancellation. */
export function canCancelInput(
  message: Pick<QueuedWorkbenchMessage, 'deliveryMode'> & {
    status: QueuedWorkbenchMessage['status'] | GuidanceWorkbenchMessage['status']
  }
): boolean {
  return (
    message.deliveryMode !== 'guidance' || ['queued', 'failed', 'running'].includes(message.status)
  )
}

/** Execution is shown in the conversation, not the pending-message queue. */
export function isPendingInput(
  message: Pick<QueuedWorkbenchMessage, 'status' | 'cancelRequested'>
): boolean {
  return message.status === 'running'
    ? message.cancelRequested === true
    : !isTerminalInput(message.status)
}

/** Ordinary acceptance is already represented by the outgoing conversation row. */
export function isVisibleQueueInput(
  message: Pick<QueuedWorkbenchMessage, 'status' | 'cancelRequested' | 'directSubmission'>
): boolean {
  return (
    isPendingInput(message) &&
    (!message.directSubmission ||
      message.cancelRequested === true ||
      message.status === 'unknown' ||
      message.status === 'failed')
  )
}

/** Late observations may not undo an observed terminal state or cancellation intent. */
export function applyInputDelivery(
  rows: RuntimePaneQueuedMessage[],
  id: string,
  delivery: RuntimeInputDelivery
): RuntimePaneQueuedMessage[] {
  const nextRows = rows
    .map(row => {
      if (
        ![
          'running',
          'completed',
          'execution_failed',
          'interrupted',
          'unknown',
          'accepted',
          'applied',
        ].includes(delivery?.status)
      )
        return row
      if (
        row.id !== id ||
        isTerminalInput(row.status) ||
        (row.turnId && delivery.turnId && row.turnId !== delivery.turnId)
      )
        return row
      if (delivery.status === 'accepted' && (row.status === 'running' || row.turnId)) return row
      if (delivery.status === 'unknown' && (row.turnId || row.status === 'accepted')) return row
      const next = {
        ...row,
        ...delivery,
        // Only an ordinary turn receipt names this input's executing turn.
        deliveryMode: delivery.status === 'running' ? undefined : row.deliveryMode,
        error: undefined,
        notice: undefined,
        cancelRequested:
          row.cancelRequested &&
          !(row.deliveryMode === 'guidance' && delivery.status === 'accepted') &&
          (delivery.status === 'running' ||
            delivery.status === 'accepted' ||
            delivery.status === 'unknown' ||
            delivery.status === 'interrupted'),
      }
      return Object.entries(next).every(([field, value]) =>
        row[field as keyof RuntimePaneQueuedMessage] === value) ? row : next
    })
    .filter(
      row => !isTerminalInput(row.status) || (row.status === 'interrupted' && row.cancelRequested)
    )
  return nextRows.length === rows.length && nextRows.every((row, index) => row === rows[index])
    ? rows : nextRows
}
