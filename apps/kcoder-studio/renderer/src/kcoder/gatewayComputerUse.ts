import i18n from '@/i18n'
import type { GatewayServer } from './gatewayRpc'
import type { GatewayClient } from './gatewayRuntimeTypes'

/** Host leases remain per-turn; an explicit session grant can authorize later turns. */
export function computerUseTurnParams(
  params: Record<string, unknown>,
  client: GatewayClient,
  server: Pick<GatewayServer, 'transport'>,
  retry = false,
  sessionApproved = false
): { computerUse?: { approved: true; target: 'local_windows_desktop' } } {
  const authorization = params.computerUse
  if (authorization == null) return {}
  if (
    typeof authorization !== 'object' ||
    Array.isArray(authorization) ||
    Object.keys(authorization).some(key => !['approved', 'target'].includes(key)) ||
    (authorization as Record<string, unknown>).approved !== true ||
    (authorization as Record<string, unknown>).target !== 'local_windows_desktop'
  )
    throw new Error(i18n.t('common:computerUse.invalidApproval'))
  if (retry && !sessionApproved) throw new Error(i18n.t('common:computerUse.newTurnRequired'))
  if (server.transport !== 'local') throw new Error(i18n.t('common:computerUse.localOnly'))
  if (client.supportsExperimental?.('computerUseTurnV1') !== true)
    throw new Error(i18n.t('common:computerUse.unsupportedTarget'))
  return { computerUse: { approved: true, target: 'local_windows_desktop' } }
}
