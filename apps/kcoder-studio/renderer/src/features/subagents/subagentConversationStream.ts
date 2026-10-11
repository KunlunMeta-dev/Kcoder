import { reduceWorkbenchMessages } from '@wegent/chat-core'
import type { Attachment, TurnFileChangesSummary } from '@/types/api'
import type {
  RuntimeSubagentConversationEvent,
  RuntimeSubagentConversationSnapshot,
} from '@/types/subagents'

/** Replay uses the same reducer as the ordinary session. Snapshots remain authoritative. */
export function applySubagentConversationEvent(
  snapshot: RuntimeSubagentConversationSnapshot,
  event: RuntimeSubagentConversationEvent
): { snapshot: RuntimeSubagentConversationSnapshot; resubscribe: boolean } {
  if (
    event.threadId !== snapshot.threadId ||
    event.agentId !== snapshot.agentId ||
    event.subscriptionId !== snapshot.subscriptionId
  )
    return { snapshot, resubscribe: false }
  if (event.type === 'disconnected') return { snapshot, resubscribe: true }
  if (event.type === 'reset') {
    if (event.runId === snapshot.runId && event.sequence < snapshot.sequence)
      return { snapshot, resubscribe: false }
    return { snapshot: event, resubscribe: false }
  }
  if (event.runId !== snapshot.runId) return { snapshot, resubscribe: true }
  if (event.sequence <= snapshot.sequence) return { snapshot, resubscribe: false }
  if (event.sequence !== snapshot.sequence + 1) return { snapshot, resubscribe: true }
  const messages = event.actions.reduce(
    (messages, action) =>
      reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>(messages, action),
    snapshot.messages
  )
  return {
    snapshot: {
      ...snapshot,
      sequence: event.sequence,
      messages,
      active: event.terminalStatus ? false : snapshot.active,
    },
    resubscribe: false,
  }
}
