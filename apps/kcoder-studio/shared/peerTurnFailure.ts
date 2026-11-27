import type { ProviderFailureDetails } from './providerFailure'

export const PEER_TURN_AUTHORIZATION_CODES = Object.freeze([
  'peer_provider_invocation_busy', 'peer_provider_response_required', 'peer_provider_scope_turn_changed',
  'peer_provider_start_actual_stream_required', 'peer_provider_start_already_begun',
  'peer_provider_start_already_dispatched', 'peer_provider_start_begin_unconfirmed', 'peer_provider_start_begin_unknown',
  'peer_provider_start_cancelled', 'peer_provider_start_current_authorization_required',
  'peer_provider_start_current_host_required', 'peer_provider_start_original_message_changed',
  'peer_provider_start_original_message_required', 'peer_provider_start_original_permit_not_current',
  'peer_provider_start_original_permit_required', 'peer_provider_start_original_record_unavailable',
  'peer_provider_start_original_read_busy', 'peer_provider_start_owner_changed', 'peer_provider_start_owner_ineligible',
  'peer_provider_start_owner_unavailable', 'peer_provider_start_permit_already_owned', 'peer_provider_start_permit_not_current',
  'peer_wake_authorization_deferred', 'peer_wake_owner_changed', 'target_turn_changed', 'target_turn_owner_busy',
  'target_turn_history_scope_required',
  'peer_provider_start_unconfirmed',
] as const)
export type PeerTurnAuthorizationCode = (typeof PEER_TURN_AUTHORIZATION_CODES)[number]
export type PeerTurnFailure = { kind: 'authorization'; reason: PeerTurnAuthorizationCode } | { kind: 'legacy_unknown' }

/** Presentation only. Neither a safe reason nor an automatic-turn ID grants recovery or replay. */
export function peerTurnFailure(input: {
  error?: string
  /** Supply already decoded Provider facts. */
  providerFailure?: ProviderFailureDetails
  turnId?: string
  attemptId?: string
}): PeerTurnFailure | undefined {
  const error = input.error?.trim() ?? ''
  const facts = input.providerFailure
  // A real HTTP failure remains a model/transport failure, even for a peer turn.
  if (facts?.http_status != null || /\bHTTP(?:\/[\d.]+)?\s+\d{3}\b/i.test(error)) return undefined
  if (!facts) {
    const code = /^KCoder peer turn authorization failed \[([a-z0-9_]{1,128})\]$/.exec(error)?.[1]
    if (code && PEER_TURN_AUTHORIZATION_CODES.includes(code as PeerTurnAuthorizationCode))
      return { kind: 'authorization', reason: code as PeerTurnAuthorizationCode }
  }
  const identity = input.turnId ?? input.attemptId ?? ''
  if (facts?.category === 'provider_error' &&
      /^peer-[0-9]{1,20}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(identity) &&
      /\bProvider error: unknown_error\. Response details withheld\./.test(error))
    return { kind: 'legacy_unknown' }
  return undefined
}
