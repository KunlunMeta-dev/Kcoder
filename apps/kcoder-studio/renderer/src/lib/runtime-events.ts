import { runtimeTransport } from './runtime-transport'

export interface RuntimeEvent<T> {
  event: string
  id: number
  payload: T
}

export type EventCallback<T> = (event: RuntimeEvent<T>) => void
export type UnlistenFn = () => void

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const transport = runtimeTransport()
  const listeners = transport.listeners.get(event) ?? new Set<(payload: unknown) => void>()
  transport.listeners.set(event, listeners)
  const listener = (payload: unknown) => handler({ event, id: 0, payload: payload as T })
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function emit<T>(event: string, payload?: T): Promise<void> {
  const transport = runtimeTransport()
  for (const listener of [...(transport.listeners.get(event) ?? [])]) listener(payload)
}
