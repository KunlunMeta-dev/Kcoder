const ACCOUNT_CONTEXT_EVENT = 'kcoder:account-context-invalidated'
const ACCOUNT_CONTEXT_CHANNEL = 'kcoder-account-context'
const ownChannelSource = `tab-${Math.random().toString(36).slice(2)}`
let ownEventSequence = 0
const revisions = new Map<string, object>()
const deliveredEvents = new Set<string>()
const listeners = new Set<{ handler: (targetId: string) => void }>()
let stopTransport: (() => void) | undefined

/** Capture before an await; validate only the target eventually resolved by the request. */
export function captureAccountContextRevision(): (targetId: string) => boolean {
  const captured = new Map(revisions)
  return targetId => captured.get(targetId) === revisions.get(targetId)
}

function deliver(targetId: string, eventId?: string) {
  // Modern events can reach us through both local and broadcast transports.
  // Legacy broadcasts have one receiver per document, so they advance once too.
  if (eventId && eventId.length <= 160) {
    const key = `${targetId}\0${eventId}`
    if (deliveredEvents.has(key)) return
    deliveredEvents.add(key)
    if (deliveredEvents.size > 512) deliveredEvents.delete(deliveredEvents.values().next().value!)
  }
  revisions.set(targetId, {})
  for (const subscription of [...listeners]) {
    try {
      subscription.handler(targetId)
    } catch {
      console.error('[KCoder] account context listener failed')
    }
  }
}

function startTransport() {
  if (stopTransport || typeof window === 'undefined') return
  const local = (event: Event) => {
    const data = (event as CustomEvent<{ targetId?: string; eventId?: string }>).detail
    if (typeof data?.targetId === 'string')
      deliver(data.targetId, typeof data.eventId === 'string' ? data.eventId : undefined)
  }
  window.addEventListener(ACCOUNT_CONTEXT_EVENT, local)
  let channel: BroadcastChannel | undefined
  try {
    channel = new window.BroadcastChannel(ACCOUNT_CONTEXT_CHANNEL)
    channel.onmessage = event => {
      const data = event.data as {
        type?: string
        targetId?: string
        source?: string
        eventId?: string
      } | null
      if (!data || data.type !== 'account-changed' || data.source === ownChannelSource) return
      if (typeof data.targetId === 'string')
        deliver(data.targetId, typeof data.eventId === 'string' ? data.eventId : undefined)
    }
  } catch {
    /* Same-document invalidation remains available without BroadcastChannel. */
  }
  stopTransport = () => {
    window.removeEventListener(ACCOUNT_CONTEXT_EVENT, local)
    channel?.close()
    stopTransport = undefined
  }
}

export function notifyAccountContextChange(targetId: string): void {
  const eventId = `${ownChannelSource}:${++ownEventSequence}`
  deliver(targetId, eventId)
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(ACCOUNT_CONTEXT_EVENT, { detail: { targetId, eventId } }))
  try {
    if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return
    const channel = new window.BroadcastChannel(ACCOUNT_CONTEXT_CHANNEL)
    channel.postMessage({ type: 'account-changed', targetId, source: ownChannelSource, eventId })
    channel.close()
  } catch {
    /* Local listeners have already received the same event. */
  }
}

export function listenAccountContextChanges(handler: (targetId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const subscription = { handler }
  listeners.add(subscription)
  startTransport()
  return () => {
    listeners.delete(subscription)
    if (listeners.size === 0) stopTransport?.()
  }
}
