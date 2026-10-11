import type { GatewayServer } from './gatewayRpc'
export function scopedModelCatalog(
  catalog: Record<string, unknown>,
  target: GatewayServer,
  supportsSelection: boolean
) {
  return {
    ...catalog,
    supportsModelSelectionMode: supportsSelection,
    executionScope: {
      targetId: target.id,
      accountMode: target.security?.identity.mode === 'kcoder-account' ? 'account' : 'shared',
      username: target.accountIdentity?.username ?? null,
      principalId: target.accountIdentity?.principalId ?? null,
    },
  }
}
