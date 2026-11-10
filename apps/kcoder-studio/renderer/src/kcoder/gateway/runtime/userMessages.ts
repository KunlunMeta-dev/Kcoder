import { parsePersistedKCoderUserMessage, visibleRuntimeUserMessage } from '@/lib/runtime-user-message'
import { record, text } from './contracts'
import type { NormalizedRuntimeMessage } from '@/types/api'

/** Decode the original visible input; routing identity is supplied by the live task owner. */
export function visibleUserItem(itemValue: unknown): NormalizedRuntimeMessage | null {
  const item = record(itemValue)
  if (item.type !== 'userMessage') return null
  const message = record(item.content ?? item.message)
  const id = text(message.id) ?? text(item.id)
  const raw = typeof message.content === 'string' ? message.content : text(item.text)
  if (!id || raw == null || (message.role != null && message.role !== 'user')) return null
  const parsed = parsePersistedKCoderUserMessage(raw)
  const content = visibleRuntimeUserMessage(raw)
  if (!content) return null
  const clientMessageId = text(message.clientMessageId) ?? text(item.clientMessageId) ?? parsed.clientMessageId
  const timestamp = message.timestampMs
  return {
    id, role: 'user', content, status: 'completed',
    ...(message.contentTruncated === true ? { contentTruncated: true } : {}),
    ...(typeof message.contentOriginalChars === 'number' && Number.isSafeInteger(message.contentOriginalChars)
      ? { contentOriginalChars: message.contentOriginalChars } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0 &&
      timestamp <= 8_640_000_000_000_000 ? { createdAt: new Date(timestamp).toISOString() } : {}),
  }
}
