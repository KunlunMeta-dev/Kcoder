import { isContract } from '../../../../shared/generated/validator.mjs'
import type { RemoteCapabilityEntry } from '../../../../shared/generated/contracts'

function unobserved(
  state: 'unknown' | 'unavailable' | 'denied',
  reasonCode: string
): RemoteCapabilityEntry {
  return {
    id: 'gateway:relay-registration',
    capability: 'relay.registration',
    purpose: 'relay_transport_registration',
    targetId: 'gateway',
    transport: 'relay',
    protocol: 'kcoder_relay',
    protocolVersion: null,
    implementationVersion: null,
    state,
    identityState: 'unknown',
    businessState: 'unknown',
    nativeOwner: null,
    schemas: [],
    boundary: {
      resource: null,
      location: 'relay_registration_on_gateway',
      authorization: 'gateway_admin_metadata_only',
      allowedModels: 'not_applicable_transport',
      budget: 'not_reserved',
      tools: 'not_applicable_transport',
      confirmation: 'native_request_policy',
      inputTransfer: 'not_observed',
      resultTransfer: 'not_observed',
    },
    observedAt: null,
    reasonCode,
  }
}
/** One authenticated metadata GET. No pairing, enrollment, native RPC or connection creation. */
export async function readTransportObservations(
  signal?: AbortSignal
): Promise<RemoteCapabilityEntry[]> {
  signal?.throwIfAborted()
  const abort = new AbortController()
  const cancel = () => abort.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 5000)
  try {
    const response = await fetch('/api/runtime/remotes/observations', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: abort.signal,
    })
    signal?.throwIfAborted()
    if (response.status === 401) throw new Error('REMOTE_CATALOG_OWNER_CHANGED')
    if (response.status === 403) return [unobserved('denied', 'RELAY_METADATA_ACCESS_DENIED')]
    if (response.status === 404)
      return [unobserved('unknown', 'RELAY_METADATA_HOST_UPGRADE_REQUIRED')]
    if (!response.ok || !response.body)
      return [unobserved('unavailable', 'RELAY_REGISTRATION_UNAVAILABLE')]
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 32768) {
          await reader.cancel()
          throw new Error('REMOTE_METADATA_TOO_LARGE')
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    if (!isContract('RemoteCapabilityCatalog', parsed)) throw new Error('REMOTE_METADATA_INVALID')
    const catalog =
      parsed as import('../../../../shared/generated/contracts').RemoteCapabilityCatalog
    if (catalog.entries.length !== 1 || catalog.nextCursor != null)
      throw new Error('REMOTE_METADATA_INVALID')
    const entry = catalog.entries[0]
    if (
      entry.capability !== 'relay.registration' ||
      entry.targetId !== 'gateway' ||
      entry.transport !== 'relay' ||
      entry.protocol !== 'kcoder_relay' ||
      entry.nativeOwner != null ||
      entry.businessState !== 'unknown' ||
      (entry.boundary.resource != null && entry.boundary.resource.kind !== 'connection')
    )
      throw new Error('REMOTE_METADATA_INVALID')
    return structuredClone(catalog.entries)
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && error.message === 'REMOTE_CATALOG_OWNER_CHANGED') throw error
    return [unobserved('unavailable', 'RELAY_REGISTRATION_UNAVAILABLE')]
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}
