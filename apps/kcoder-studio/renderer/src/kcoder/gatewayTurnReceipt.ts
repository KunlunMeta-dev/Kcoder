import i18n from '@/i18n'
import { GatewayRpcError } from './gatewayRpc'
import { isUnconfirmedRpcFailure } from './rpcOutcome'
import { startTurnWithReceipt as readReceiptAfterAmbiguousStart, type ReceiptClient, type TurnStartResidency } from '../../../shared/turnReceipt'

export class TurnAcceptanceUnknownError extends Error {
  constructor(cause: unknown) {
    super(i18n.t('workbench.turn_acceptance_unknown'), { cause })
    this.name = 'TurnAcceptanceUnknownError'
  }
}

export function startTurnWithReceipt<C extends ReceiptClient>(
  client: C,
  params: Record<string, unknown>,
  recoverClient: () => Promise<C>,
  residency?: TurnStartResidency<C>
) {
  return readReceiptAfterAmbiguousStart(client, params, recoverClient, {
    invalidReply: () => new GatewayRpcError('Invalid turn acceptance reply', -1, undefined, 'runtime-session', 'invalid-response'),
    ambiguous: isUnconfirmedRpcFailure,
    unknownOutcome: cause => new TurnAcceptanceUnknownError(cause),
  }, residency)
}
