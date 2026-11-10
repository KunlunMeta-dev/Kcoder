import { MobileRpcError } from '@/gateway/rpc'
import type { JsonRecord } from '@/gateway/rpc'
import type { SettingsTargetRpcChannel, SettingsTargetRpcClient } from './settings-target'

const PREFIX = 'migration/history/view/'
/** The Mobile socket never reconnects itself. Keep its exact instance across resource calls. */
export class SettingsHistoryViewOwners {
  private readonly owners = new Map<string, { client: SettingsTargetRpcClient; channel: SettingsTargetRpcChannel; binding: string }>()
  handles(method: string): boolean { return ['open', 'read', 'renew', 'release'].some(name => method === PREFIX + name) }
  private nonce(params: JsonRecord): string {
    if (typeof params.requestId !== 'string' || params.requestId.length !== 36) throw new MobileRpcError('history_view_invalid_identity', -1, 'protocol', 'not-sent')
    return params.requestId
  }
  private changed(delivery: 'not-sent' | 'unknown' = 'not-sent'): never { throw new MobileRpcError('migration_history_view_connection_changed', -1, 'transport', delivery) }
  existing(method: string, params: JsonRecord, channel: SettingsTargetRpcChannel, current: SettingsTargetRpcClient | undefined, delivery: 'not-sent' | 'unknown' = 'not-sent'): SettingsTargetRpcClient | null {
    if (!this.handles(method)) return null
    const owner = this.owners.get(this.nonce(params))
    if (!owner) { if (method === PREFIX + 'open') return null; return this.changed() }
    if (owner.channel !== channel || owner.client !== current) return this.changed(delivery)
    if (method === PREFIX + 'open' && owner.binding !== JSON.stringify([params.jobId, params.expectedArchiveId, params.viewId ?? null])) return this.changed()
    return owner.client
  }
  bind(method: string, params: JsonRecord, channel: SettingsTargetRpcChannel, client: SettingsTargetRpcClient): void {
    if (!this.handles(method)) return
    const nonce = this.nonce(params), owner = this.owners.get(nonce)
    if (owner) { this.existing(method, params, channel, client); return }
    if (method !== PREFIX + 'open' || this.owners.size >= 256) return this.changed()
    this.owners.set(nonce, { client, channel, binding: JSON.stringify([params.jobId, params.expectedArchiveId, params.viewId ?? null]) })
  }
  clear(): void { this.owners.clear() }
}
