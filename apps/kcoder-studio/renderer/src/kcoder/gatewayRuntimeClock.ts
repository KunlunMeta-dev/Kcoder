import { captureAccountContextRevision } from './accountContextEvents'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { sharePendingRead, type PendingRead } from '@/lib/pendingRead'

interface ClockReads {
  isCurrent: () => boolean
  pending: Map<string, PendingRead<{ sampledAtMs: number }>>
}
const readsByRuntime = new WeakMap<GatewayRuntimeCore, WeakMap<GatewayClient, ClockReads>>()

/** A single bounded resource sample provides the target's existing clock fact. */
export async function readRuntimeClock(runtime: GatewayRuntimeCore, serverId: string) {
  if (!serverId) throw new Error('An execution target is required')
  const accountValid = captureAccountContextRevision()
  const sourceCurrent = runtime.captureReadSource(serverId)
  const assertSource = () => {
    if (!sourceCurrent() || !accountValid(serverId)) throw new Error('Execution target changed')
  }
  const target = await runtime.serverForParams({ deviceId: serverId }).finally(assertSource)
  if (target.id !== serverId) throw new Error('Execution target changed')
  const client = await runtime.commandClient(target).finally(assertSource)
  const connectionId = client.diagnosticConnection?.connectionId
  const isCurrent = () => sourceCurrent() && accountValid(serverId) &&
    !runtime.appServerDisconnectedClients.has(client) &&
    client.diagnosticConnection?.connectionId === connectionId
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Execution target changed')
  }
  assertCurrent()
  if (client.supportsExperimental?.('serverResourceSnapshotV1') !== true ||
      client.supportsExperimental?.('eventTimestampsV1') !== true) return null
  const reads = readsByRuntime.get(runtime) ?? new WeakMap<GatewayClient, ClockReads>()
  readsByRuntime.set(runtime, reads)
  let scopeReads = reads.get(client)
  if (!scopeReads || !scopeReads.isCurrent()) {
    scopeReads = { isCurrent, pending: new Map() }
    reads.set(client, scopeReads)
  }
  try {
    const result = await sharePendingRead(scopeReads.pending, 'clock', undefined,
      () => {
        assertCurrent()
        return client.request<{ sampledAtMs: number }>('server/resources/read', {})
      }).finally(assertCurrent)
    return { sampledAtMs: result.sampledAtMs }
  } finally {
    if (scopeReads.pending.size === 0 && reads.get(client) === scopeReads) reads.delete(client)
  }
}
