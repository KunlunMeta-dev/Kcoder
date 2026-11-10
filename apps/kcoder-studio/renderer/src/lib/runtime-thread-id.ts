import type { RuntimeTaskAddress } from '@/types/api'

/** Read the original runtime identity; a presentation task ID is not a session ID. */
export function runtimeThreadId(address?: RuntimeTaskAddress | null): string | null {
  if (typeof address?.threadId === 'string' && address.threadId.trim()) return address.threadId
  const handle = address?.runtimeHandle
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return null
  const threadId = handle.sessionId ?? handle.session_id ?? handle.threadId ?? handle.thread_id
  return typeof threadId === 'string' && threadId.trim() ? threadId : null
}
