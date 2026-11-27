// Hands an unsent memory draft (for example from `/remember <fact>`) to the Memory
// center. The draft only prefills the form; saving still requires the user's
// explicit confirmation there. It stays in memory, never in the URL or storage.

const DRAFT_LIFETIME_MS = 60_000

let pending: { content: string; expiresAt: number } | null = null
const listeners = new Set<() => void>()

export function offerMemoryDraft(content: string) {
  const trimmed = content.trim()
  if (!trimmed) return
  pending = { content: trimmed, expiresAt: Date.now() + DRAFT_LIFETIME_MS }
  for (const listener of [...listeners]) listener()
}

/** Reads the pending draft without consuming it, for render-time initial state. */
export function peekMemoryDraft(): string | null {
  return pending && pending.expiresAt > Date.now() ? pending.content : null
}

/** Returns and clears the pending draft; expired drafts are discarded. */
export function takeMemoryDraft(): string | null {
  const current = pending
  pending = null
  return current && current.expiresAt > Date.now() ? current.content : null
}

export function subscribeMemoryDraft(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
