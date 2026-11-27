import type { ModelCatalogTarget } from '@/api/models'
import type { UnifiedModelListResponse } from '@/types/api'
import { sharePendingRead, type PendingRead } from '@/lib/pendingRead'

export interface ModelCatalogReader {
  listModels(target?: ModelCatalogTarget, options?: { signal?: AbortSignal }): Promise<UnifiedModelListResponse>
}
interface Scope {
  revision: number
  events: WeakSet<Event>
  flights: Map<string, PendingRead<UnifiedModelListResponse>>
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
  const scope = scopeFor(api)
  const flightKey = `${scope.revision}:${key}`
  return sharePendingRead(scope.flights, flightKey, signal,
    sharedSignal => api.listModels(target, { signal: sharedSignal }))
}
