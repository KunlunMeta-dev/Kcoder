import type { GatewayServer } from './gatewayRpc'
export function scopedModelCatalog(
  catalog: Record<string, unknown>,
  target: GatewayServer,
  supportsSelection: boolean,
  supportsTurnModelSwitch: boolean
) {
  return {
    ...catalog,
    supportsModelSelectionMode: supportsSelection,
    supportsTurnModelSwitch: supportsTurnModelSwitch && catalog.supportsTurnModelSwitch === true,
    executionScope: {
      targetId: target.id,
      accountMode: target.security?.identity.mode === 'kcoder-account' ? 'account' : 'shared',
      username: target.accountIdentity?.username ?? null,
      principalId: target.accountIdentity?.principalId ?? null,
    },
  }
}
