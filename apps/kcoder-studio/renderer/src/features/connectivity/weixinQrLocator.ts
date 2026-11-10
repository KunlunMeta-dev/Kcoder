import { isContract } from '../../../../shared/generated/validator.mjs'
import type { IntegrationRevisionRef, IntegrationScope } from '../../../../shared/generated/contracts'
interface Target { serverId: string; workspacePath?: string }
export interface WeixinQrLocator { requestId: string; connectionRef: IntegrationRevisionRef; expiresAtMs: number }
interface LocatorRecord extends WeixinQrLocator { version: 1; target: { serverId: string; workspacePath: string | null }; accountId: string; scope: IntegrationScope }
const scopeKey = (scope: IntegrationScope) => JSON.stringify([scope.accountId, scope.targetId, scope.workspaceId, scope.identityGeneration, scope.targetRevision, scope.organizationId ?? null])
const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/** Session metadata is an original-operation locator. Native receipts alone determine its outcome. */
export function createWeixinQrLocators(target: Target, scope: IntegrationScope) {
  const capturedTarget = { serverId: target.serverId, workspacePath: target.workspacePath ?? null }
  const capturedScope: IntegrationScope = { accountId: scope.accountId, targetId: scope.targetId, workspaceId: scope.workspaceId, identityGeneration: scope.identityGeneration, targetRevision: scope.targetRevision, ...(scope.organizationId === undefined ? {} : { organizationId: scope.organizationId }) }
  const key = (connectionId: string) => JSON.stringify(['kcoder-weixin-qr-original-v1', capturedTarget, scopeKey(capturedScope), connectionId])
  const read = (connectionId: string): WeixinQrLocator | undefined => {
    const raw = window.sessionStorage.getItem(key(connectionId)); if (!raw) return
    try {
      const record = JSON.parse(raw) as LocatorRecord
      if (!record || !exactKeys(record, ['version', 'requestId', 'connectionRef', 'expiresAtMs', 'target', 'accountId', 'scope']) || record.version !== 1
        || !record.target || !exactKeys(record.target, ['serverId', 'workspacePath']) || JSON.stringify(record.target) !== JSON.stringify(capturedTarget)
        || record.accountId !== capturedScope.accountId || !isContract('IntegrationScope', record.scope) || scopeKey(record.scope) !== scopeKey(capturedScope)
        || !isContract('IntegrationRevisionRef', record.connectionRef) || record.connectionRef.id !== connectionId || !record.connectionRef.revision
        || typeof record.requestId !== 'string' || !record.requestId || new TextEncoder().encode(record.requestId).length > 256 || Array.from(record.requestId).some(char => { const code = char.codePointAt(0)!; return code < 32 || code >= 127 && code <= 159 })
        || !Number.isSafeInteger(record.expiresAtMs) || record.expiresAtMs < 1) throw Error('invalid locator')
      // Expiry never proves that a private save did not execute. Keep expired locators.
      return structuredClone({ requestId: record.requestId, connectionRef: record.connectionRef, expiresAtMs: record.expiresAtMs })
    } catch { throw new Error('WEIXIN_QR_ORIGINAL_RESULT_UNCONFIRMED') }
  }
  return {
    read,
    begin(locator: WeixinQrLocator) {
      const old = read(locator.connectionRef.id)
      if (old && (old.requestId !== locator.requestId || JSON.stringify(old.connectionRef) !== JSON.stringify(locator.connectionRef))) throw new Error('WEIXIN_QR_ORIGINAL_RESULT_UNCONFIRMED')
      if (old) return
      const record: LocatorRecord = { version: 1, requestId: locator.requestId, connectionRef: { id: locator.connectionRef.id, revision: locator.connectionRef.revision }, expiresAtMs: locator.expiresAtMs, target: capturedTarget, accountId: capturedScope.accountId, scope: capturedScope }
      window.sessionStorage.setItem(key(locator.connectionRef.id), JSON.stringify(record))
      read(locator.connectionRef.id)
    },
    complete(connectionId: string, requestId: string) {
      const original = read(connectionId)
      if (original?.requestId === requestId) window.sessionStorage.removeItem(key(connectionId))
    },
  }
}
