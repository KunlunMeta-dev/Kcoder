import type { ModelCatalogTarget } from '@/api/models'
import type { UnifiedModelListResponse } from '@/types/api'

export interface ModelCatalogReader {
  listModels(target?: ModelCatalogTarget, options?: { signal?: AbortSignal }): Promise<UnifiedModelListResponse>
}
interface Flight {
  controller: AbortController
  promise: Promise<UnifiedModelListResponse>
  subscribers: number
}
interface Scope {
  revision: number
  events: WeakSet<Event>
  flights: Map<string, Flight>
}
const scopes = new WeakMap<ModelCatalogReader, Scope>()
function scopeFor(api: ModelCatalogReader): Scope {
  let scope = scopes.get(api)
  if (!scope) {
    scope = { revision: 0, events: new WeakSet(), flights: new Map() }
    scopes.set(api, scope)
  }
  return scope
}

/** A settings/account event invalidates once even when several views receive it. */
export function invalidateModelCatalog(api: ModelCatalogReader, event: Event): void {
  const scope = scopeFor(api)
  if (scope.events.has(event)) return
  scope.events.add(event)
  scope.revision++
}

/** Coalesce only concurrent reads; never retain an account/configuration result. */
export function readModelCatalog(
  api: ModelCatalogReader,
  key: string,
  target: ModelCatalogTarget | undefined,
  signal: AbortSignal
): Promise<UnifiedModelListResponse> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  const scope = scopeFor(api)
  const flightKey = `${scope.revision}:${key}`
  let flight = scope.flights.get(flightKey)
  if (!flight) {
    const controller = new AbortController()
    flight = { controller, subscribers: 0, promise: Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return api.listModels(target, { signal: controller.signal })
    }) }
    scope.flights.set(flightKey, flight)
    const current = flight
    void flight.promise.finally(() => {
      if (scope.flights.get(flightKey) === current) scope.flights.delete(flightKey)
    }).catch(() => undefined)
  }
  const current = flight
  current.subscribers++
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      current.subscribers--
      if (current.subscribers === 0) {
        if (scope.flights.get(flightKey) === current) scope.flights.delete(flightKey)
        current.controller.abort()
      }
      callback()
    }
    const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    signal.addEventListener('abort', abort, { once: true })
    current.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
  })
}
