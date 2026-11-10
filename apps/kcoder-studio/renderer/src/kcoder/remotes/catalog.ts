import type {
  RemoteCapabilityCatalog,
  RemoteCapabilityCatalogReadParams,
  RemoteCapabilityEntry,
} from '../../../../shared/generated/contracts'
import { captureAccountContextRevision } from '../accountContextEvents'
import type { GatewayRuntimeCore } from '../gateway/runtime/core'
import { hookTargetScope } from '../gatewayHookConfiguration'
import { createRandomUuid } from '@/lib/random-id'
import { projectRemoteEntries } from './projection'
import { readTransportObservations } from './transportObservations'
import type { NegotiatedRemoteFacts } from './negotiatedFacts'

export class RemoteCatalogError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}
interface CapturedSource {
  targetId: string
  targetScope: string
  facts: NegotiatedRemoteFacts | null
}
interface CatalogSnapshot {
  id: string
  observedAt: string
  generation: number
  serversFingerprint: string
  sourcesFingerprint: string
  transportFingerprint: string
  entries: RemoteCapabilityEntry[]
  accountValid: (targetId: string) => boolean
  epochs: Map<string, object | undefined>
  cursors: Map<string, number>
  createdAt: number
}
const snapshots = new WeakMap<GatewayRuntimeCore, CatalogSnapshot>()
const PAGE_SIZE = 10
const MAX_ENTRIES = 16384

function assertAvailable(runtime: GatewayRuntimeCore, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (runtime.disposed) throw new RemoteCatalogError('REMOTE_CATALOG_CLOSED')
}

/** Stop waiting for this caller, without cancelling another owner's metadata read. */
async function boundedRead<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const finish = (action: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      action()
    }
    const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    const timer = setTimeout(
      () => finish(() => reject(new RemoteCatalogError('REMOTE_CATALOG_TIMEOUT'))),
      5000
    )
    signal?.addEventListener('abort', abort, { once: true })
    pending.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    )
  })
}

function sources(runtime: GatewayRuntimeCore): CapturedSource[] {
  return [...runtime.connectionsByClient.values()]
    .filter(
      ({ client, channel, server, serverId }) =>
        channel === 'runtime' && serverId === server.id &&
        !runtime.appServerDisconnectedClients.has(client)
    )
    .map(({ client, server }) => ({
      targetId: server.id,
      targetScope: hookTargetScope(server),
      facts: client.readNegotiatedRemoteFacts?.() ?? null,
    }))
    .sort(
      (a, b) =>
        a.targetId.localeCompare(b.targetId) ||
        a.targetScope.localeCompare(b.targetScope) ||
        (a.facts?.connectionId ?? '').localeCompare(b.facts?.connectionId ?? '')
    )
}
function sourceFingerprint(value: CapturedSource[]) {
  return JSON.stringify(
    value.map(source => ({
      ...source,
      facts: source.facts
        ? {
            ...source.facts,
            capabilities: Object.fromEntries(
              Object.entries(source.facts.capabilities).sort(([a], [b]) => a.localeCompare(b))
            ),
          }
        : null,
    }))
  )
}

/** Observes existing connections only; no commandClient, handshake, task, or runner creation. */
export async function readRemoteCatalog(
  this: GatewayRuntimeCore,
  raw: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<RemoteCapabilityCatalog> {
  assertAvailable(this, options?.signal)
  if (
    Object.keys(raw).some(key => key !== 'cursor') ||
    ('cursor' in raw &&
      raw.cursor !== undefined &&
      raw.cursor !== null &&
      typeof raw.cursor !== 'string')
  )
    throw new RemoteCatalogError('REMOTE_CATALOG_REQUEST_INVALID')
  const params = raw as RemoteCapabilityCatalogReadParams
  const cursor = params.cursor ?? undefined
  if (cursor !== undefined && (!cursor || cursor.length > 160))
    throw new RemoteCatalogError('REMOTE_CATALOG_CURSOR_INVALID')
  const accountValid = captureAccountContextRevision()
  const generation = this.workspaceScanGeneration
  const serversPromise = this.serversPromise
  const servers = await boundedRead(this.servers(), options?.signal)
  assertAvailable(this, options?.signal)
  if (servers.length > 1024 || this.connectionsByClient.size > 1024)
    throw new RemoteCatalogError('REMOTE_CATALOG_TOO_LARGE')
  // The first servers() creates the shared promise; replacement means target configuration changed.
  if (
    this.workspaceScanGeneration !== generation ||
    (serversPromise !== null && this.serversPromise !== serversPromise) ||
    servers.some(server => !accountValid(server.id))
  )
    throw new RemoteCatalogError('REMOTE_CATALOG_OWNER_CHANGED')
  const serversFingerprint = JSON.stringify(servers.map(server => hookTargetScope(server)).sort())
  const establishedServersPromise = this.serversPromise
  const transports = await readTransportObservations(options?.signal)
  assertAvailable(this, options?.signal)
  if (
    this.workspaceScanGeneration !== generation ||
    this.serversPromise !== establishedServersPromise ||
    JSON.stringify(servers.map(server => hookTargetScope(server)).sort()) !== serversFingerprint ||
    servers.some(server => !accountValid(server.id))
  )
    throw new RemoteCatalogError('REMOTE_CATALOG_OWNER_CHANGED')
  const transportFingerprint = JSON.stringify(
    transports.map(entry => ({ ...entry, observedAt: null }))
  )
  const captured = sources(this)
  const sourcesFingerprint = sourceFingerprint(captured)
  let snapshot: CatalogSnapshot
  if (cursor !== undefined) {
    const existing = snapshots.get(this)
    if (
      !existing ||
      existing.generation !== generation ||
      Date.now() - existing.createdAt > 60000 ||
      existing.serversFingerprint !== serversFingerprint ||
      existing.sourcesFingerprint !== sourcesFingerprint ||
      existing.transportFingerprint !== transportFingerprint ||
      servers.some(
        server =>
          !existing.accountValid(server.id) ||
          existing.epochs.get(server.id) !== this.accountEpochByTarget.get(server.id)
      ) ||
      !existing.cursors.has(cursor)
    )
      throw new RemoteCatalogError('REMOTE_CATALOG_CURSOR_STALE')
    snapshot = existing
  } else {
    let projectedCount = transports.length
    for (const server of servers) {
      const observations = captured.filter(
        source =>
          source.targetId === server.id &&
          source.targetScope === hookTargetScope(server) &&
          source.facts !== null
      )
      projectedCount += observations.length
        ? 2 +
          observations.reduce(
            (total, source) => total + 1 + Object.keys(source.facts!.capabilities).length,
            0
          )
        : 3
      if (projectedCount > MAX_ENTRIES) throw new RemoteCatalogError('REMOTE_CATALOG_TOO_LARGE')
    }
    const entries = servers.flatMap(server =>
      projectRemoteEntries(
        server,
        captured
          .filter(
            source =>
              source.targetId === server.id && source.targetScope === hookTargetScope(server)
          )
          .map(source => source.facts)
          .filter((facts): facts is NegotiatedRemoteFacts => facts !== null)
      )
    )
    entries.push(...transports)
    if (entries.length > MAX_ENTRIES) throw new RemoteCatalogError('REMOTE_CATALOG_TOO_LARGE')
    snapshot = {
      id: createRandomUuid(),
      observedAt: new Date().toISOString(),
      generation,
      serversFingerprint,
      sourcesFingerprint,
      transportFingerprint,
      entries,
      accountValid,
      epochs: new Map(servers.map(server => [server.id, this.accountEpochByTarget.get(server.id)])),
      cursors: new Map(),
      createdAt: Date.now(),
    }
    snapshots.set(this, snapshot)
  }
  const offset = cursor === undefined ? 0 : snapshot.cursors.get(cursor)!
  const end = offset + PAGE_SIZE
  let nextCursor: string | null = null
  if (end < snapshot.entries.length) {
    nextCursor = [...snapshot.cursors].find(([, value]) => value === end)?.[0] ?? createRandomUuid()
    snapshot.cursors.set(nextCursor, end)
  }
  assertAvailable(this, options?.signal)
  return structuredClone({
    snapshotId: snapshot.id,
    entries: snapshot.entries.slice(offset, end),
    nextCursor,
    total: snapshot.entries.length,
    observedAt: snapshot.observedAt,
  })
}
