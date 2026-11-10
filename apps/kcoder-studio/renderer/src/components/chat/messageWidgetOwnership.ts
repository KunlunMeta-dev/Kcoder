import { isActiveToolCallStatus } from '@wegent/chat-core'
import type { WorkbenchMessage } from '@/types/workbench'

export interface MessageWidgetOwnership {
  ownsWidgets: boolean
  attemptActive: boolean
}

/** Persisted body segments and the live tail share one presentation owner per attempt. */
export function getMessageWidgetOwnership(messages: WorkbenchMessage[]) {
  const attemptsByTurn = new Map<string, Set<string>>()
  for (const message of messages) {
    if (!message.turnId || !message.attemptId) continue
    const attempts = attemptsByTurn.get(message.turnId) ?? new Set<string>()
    attempts.add(message.attemptId)
    attemptsByTurn.set(message.turnId, attempts)
  }
  const groups = new Map<string, { owner: string; active: boolean }>()
  const keys = new Map<string, string | null>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const attempts = message.turnId ? attemptsByTurn.get(message.turnId) : undefined
    const legacyAttempt = attempts?.size === 1 ? [...attempts][0] : attempts && message.subtaskId && attempts.has(message.subtaskId) ? message.subtaskId : undefined
    const key = message.attemptId ?? legacyAttempt ?? (attempts && attempts.size > 1 ? null : message.turnId ?? message.subtaskId ?? `message:${message.id}`)
    keys.set(message.id, key)
    if (key === null) continue
    const active = message.status !== 'failed' && message.status !== 'unknown' &&
      message.runtimeStatus !== 'cancelled' &&
      (message.status === 'streaming' || Boolean(message.blocks?.some(block => isActiveToolCallStatus(block.status))))
    groups.set(key, { owner: message.id, active: active || groups.get(key)?.active === true })
  }
  return new Map([...keys].map(([id, key]) => {
    if (key === null) return [id, { ownsWidgets: false, attemptActive: false }]
    const group = groups.get(key)!
    return [id, { ownsWidgets: group.owner === id, attemptActive: group.active }]
  }))
}
