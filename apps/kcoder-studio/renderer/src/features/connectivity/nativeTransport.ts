import { requestLocalExecutor } from '@/host/localExecutor'
import { ConnectivityClient, ConnectivityClientError } from './client'
import type { ConnectivityMethod, ConnectivityPort, ConnectivityReply, ConnectivityScope, ConnectivityRequest } from './types'

const routes: Record<ConnectivityMethod, { port: ConnectivityPort; wire: string }> = {
  listConnections: { port: 'P-CONNECTION', wire: 'integrations/connectivity/listConnections' },
  readConnection: { port: 'P-CONNECTION', wire: 'integrations/connectivity/readConnection' },
  resolveCapability: { port: 'P-CONNECTION', wire: 'integrations/connectivity/resolveCapability' },
  readResourceGrant: { port: 'P-CONNECTION', wire: 'integrations/connectivity/readResourceGrant' },
  prepareConnectionAction: { port: 'P-CONNECTION', wire: 'integrations/connectivity/prepareConnectionAction' },
  inspectReadiness: { port: 'P-READINESS', wire: 'integrations/connectivity/inspectReadiness' },
  readReadiness: { port: 'P-READINESS', wire: 'integrations/connectivity/readReadiness' },
  verifyCapability: { port: 'P-READINESS', wire: 'integrations/connectivity/verifyCapability' },
  submitDelivery: { port: 'P-DELIVERY', wire: 'integrations/connectivity/submitDelivery' },
  readDelivery: { port: 'P-DELIVERY', wire: 'integrations/connectivity/readDelivery' },
  cancelDelivery: { port: 'P-DELIVERY', wire: 'integrations/connectivity/cancelDelivery' },
  reconcileDelivery: { port: 'P-DELIVERY', wire: 'integrations/connectivity/reconcileDelivery' },
}
/** The existing Gateway owns target authentication and capability negotiation. */
export function nativeConnectivityClient(scope: ConnectivityScope, target: { serverId: string; workspacePath?: string },
  owner: { signal: AbortSignal; isCurrent: () => boolean }): ConnectivityClient {
  const captured = Object.freeze(structuredClone(scope))
  const assertCurrent = () => {
    owner.signal.throwIfAborted()
    if (!owner.isCurrent()) throw new ConnectivityClientError('TARGET_CHANGED', 'repair_configuration')
  }
  return new ConnectivityClient(() => { assertCurrent(); return captured }, async <T,>(port: ConnectivityPort, method: ConnectivityMethod, request: ConnectivityRequest, signal?: AbortSignal) => {
    assertCurrent()
    const route = Object.hasOwn(routes, method) ? routes[method] : undefined
    if (!route || route.port !== port) throw new ConnectivityClientError('INTEGRATION_METHOD_UNSUPPORTED', 'repair_configuration')
    const combined = signal ? AbortSignal.any([signal, owner.signal]) : owner.signal
    const result = await requestLocalExecutor<ConnectivityReply<T>>('runtime.integrations.request', {
      ...target, method: route.wire, params: request,
    }, { signal: combined })
    combined.throwIfAborted()
    assertCurrent()
    return result
  })
}
