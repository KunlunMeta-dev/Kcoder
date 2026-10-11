import i18n from '@/i18n'
import type { GatewayServer } from './gatewayRpc'
import type { GatewayClient } from './gatewayRuntimeTypes'

/** Host leases remain per-turn; an explicit session grant can authorize later turns. */
export function computerUseTurnParams(
  params: Record<string, unknown>,
  client: GatewayClient,
  server: Pick<GatewayServer, 'transport'>,
  retry = false,
  sessionApproved = false,
  sessionContinuation = false
): {
  computerUse?: {
    approved: true
    target: 'local_windows_desktop'
    useSessionAuthorization?: boolean
  }
} {
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
  if (
    sessionContinuation &&
    (!sessionApproved ||
      client.supportsExperimental?.('computerUseSessionAuthorizationV1') !== true)
  )
    throw new Error(i18n.t('common:computerUse.newTurnRequired'))
  return {
    computerUse: {
      approved: true,
      target: 'local_windows_desktop',
      ...(client.supportsExperimental?.('computerUseSessionAuthorizationV1') === true
        ? { useSessionAuthorization: sessionContinuation }
        : {}),
    },
  }
}

export type ComputerUseRecoverResult = {
  threadId: string
  previousTurnId: string
  turnId: string
  status: 'running' | 'completed'
}
export async function requestComputerUseRecovery(
  client: GatewayClient,
  method: 'computerUse/recover' | 'computerUse/revoke',
  threadId: string,
  previousTurnId?: string
): Promise<ComputerUseRecoverResult | { revoked: boolean }> {
  if (client.supportsExperimental?.('computerUseRecoveryV1') !== true)
    throw new Error(i18n.t('common:computerUse.unsupportedTarget'))
  if (!threadId || (method === 'computerUse/recover' && !previousTurnId))
    throw new Error('A current desktop thread and previous turn are required')
  return client.request(method, {
    threadId,
    ...(method === 'computerUse/recover' ? { previousTurnId } : {}),
  })
}
