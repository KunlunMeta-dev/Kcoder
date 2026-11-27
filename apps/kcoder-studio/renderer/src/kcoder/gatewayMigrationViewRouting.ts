import type { GatewayClient } from './gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import { captureAccountContextRevision } from './accountContextEvents'
import * as C from '../../../shared/generated/contracts'
import { validHistoryLifecycleResult } from '../../../shared/migrationHistoryLifecycle'

export const HISTORY_VIEW_UNCONFIRMED_EVENT = 'kcoder:migration-history-view-unconfirmed'
export const HISTORY_VIEW_METHODS = ['open', 'read', 'renew', 'release'].map(name => `migration/history/view/${name}`)
interface Owner {
  client: GatewayClient
  connection: string
  target: string
  workspace: unknown
  job: string
  archive: string
  view: string | null
  validAccount: (target: string) => boolean
  closed: boolean
}
const owners = new WeakMap<GatewayRuntimeCore, Map<string, Owner>>()
const unconfirmed = (request: string) => window.dispatchEvent(new CustomEvent(HISTORY_VIEW_UNCONFIRMED_EVENT, { detail: { requestId: request } }))
const error = () => new Error('migration_history_view_connection_changed')

function input(method: string, params: unknown): Record<string, unknown> {
  const checks = [C.isMigrationHistoryViewOpenParams, C.isMigrationHistoryViewReadParams, C.isMigrationHistoryViewRenewParams, C.isMigrationHistoryViewReleaseParams]
  const index = HISTORY_VIEW_METHODS.indexOf(method)
  if (index < 0 || !checks[index](params)) throw new Error('migration_invalid_parameters')
  return params as Record<string, unknown>
}
function matching(owner: Owner, params: Record<string, unknown>, value: Record<string, unknown>, open: boolean) {
  if (owner.target !== params.deviceId || owner.workspace !== params.workspacePath ||
      (open && (owner.job !== value.jobId || owner.archive !== value.expectedArchiveId || owner.view !== (value.viewId ?? null))))
    throw new Error('migration_history_view_request_conflict')
}
function assertOwner(core: GatewayRuntimeCore, owner: Owner) {
  if (core.disposed || owner.closed || !owner.validAccount(owner.target) || owner.client.diagnosticConnection?.connectionId !== owner.connection || !owner.client.requestOnConnection)
    throw error()
}

async function invoke(core: GatewayRuntimeCore, owner: Owner, method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) {
  assertOwner(core, owner)
  try {
    const result = await owner.client.requestOnConnection!(owner.connection, method, params, options)
    assertOwner(core, owner)
    if (!C.isMigrationHistoryViewResult(result) || !validHistoryLifecycleResult(method, params, result)) throw new Error('migration_invalid_response')
    const lease = result.lease
    if (lease && (lease.requestId !== params.requestId || lease.jobId !== owner.job || lease.archiveId !== owner.archive || (lease.viewId ?? null) !== owner.view ||
        (params.leaseId && lease.leaseId !== params.leaseId))) throw new Error('migration_invalid_response')
    return result
  } catch (failure) {
    unconfirmed(String(params.requestId))
    throw failure
  }
}

/** Existing resource requests never resolve a target or ask commandClient to reconnect. */
export function existingHistoryView(core: GatewayRuntimeCore, params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<C.MigrationHistoryViewResult> | null {
  const method = String(params.method), value = input(method, params.params)
  const owner = owners.get(core)?.get(String(value.requestId))
  if (!owner) {
    if (method.endsWith('/open')) return null
    throw error()
  }
  matching(owner, params, value, method.endsWith('/open'))
  return invoke(core, owner, method, value, options)
}

/** First open pins the actual logical channel before sending any resource request. */
export function openHistoryView(core: GatewayRuntimeCore, client: GatewayClient, params: Record<string, unknown>, options?: { signal?: AbortSignal }) {
  const value = input(String(params.method), params.params)
  if (!client.requestOnConnection || !client.diagnosticConnection?.connectionId) throw new Error('migration_history_view_update_required')
  let records = owners.get(core)
  if (!records) { records = new Map(); owners.set(core, records) }
  const previous = records.get(String(value.requestId))
  if (previous) {
    matching(previous, params, value, true)
    return invoke(core, previous, String(params.method), value, options)
  }
  if (records.size >= 256) throw new Error('history_view_request_budget_exceeded')
  const owner: Owner = { client, connection: client.diagnosticConnection.connectionId, target: String(params.deviceId), workspace: params.workspacePath,
    job: String(value.jobId), archive: String(value.expectedArchiveId), view: typeof value.viewId === 'string' ? value.viewId : null, validAccount: captureAccountContextRevision(), closed: false }
  records.set(String(value.requestId), owner)
  const close = () => { owner.closed = true; client.removeEventListener('close', close); unconfirmed(String(value.requestId)) }
  client.addEventListener('close', close)
  return invoke(core, owner, String(params.method), value, options)
}
