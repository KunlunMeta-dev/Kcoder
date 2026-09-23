import i18n from '@/i18n'
import { GatewayRpcError } from './gatewayRpc'
import { startTurnWithReceipt as readReceiptAfterAmbiguousStart, type ReceiptClient } from '../../../shared/turnReceipt'

export class TurnAcceptanceUnknownError extends Error {
  constructor(cause: unknown) {
    super(i18n.t('workbench.turn_acceptance_unknown'), { cause })
    this.name = 'TurnAcceptanceUnknownError'
  }
}

export function startTurnWithReceipt<C extends ReceiptClient>(
  client: C,
  params: Record<string, unknown>,
  recoverClient: () => Promise<C>
) {
  return readReceiptAfterAmbiguousStart(client, params, recoverClient, {
    invalidReply: () => new GatewayRpcError('Invalid turn acceptance reply', -1, undefined, 'runtime-session', 'invalid-response'),
    ambiguous: error => error instanceof GatewayRpcError && error.code === -1 && error.reason !== 'remote',
    unknownOutcome: cause => new TurnAcceptanceUnknownError(cause),
  })
}
