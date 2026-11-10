export type RuntimeCommandHandler = (command: string, args?: unknown) => unknown | Promise<unknown>

interface RuntimeTransport {
  active: boolean
  handler: RuntimeCommandHandler
  listeners: Map<string, Set<(payload: unknown) => void>>
  previous: RuntimeTransport | null
}

let activeTransport: RuntimeTransport | null = null

export function hasRuntimeTransport(): boolean {
  return activeTransport !== null
}

export function runtimeTransport(): RuntimeTransport {
  if (!activeTransport)
    throw new DOMException('Gateway service transport is unavailable', 'AbortError')
  return activeTransport
}

export function registerRuntimeTransport(handler: RuntimeCommandHandler): () => void {
  const transport: RuntimeTransport = {
    active: true,
    handler,
    listeners: new Map(),
    previous: activeTransport,
  }
  activeTransport = transport
  return () => {
    if (!transport.active) return
    transport.active = false
    transport.listeners.clear()
    if (activeTransport !== transport) return
    let previous = transport.previous
    while (previous && !previous.active) previous = previous.previous
    activeTransport = previous
  }
}
