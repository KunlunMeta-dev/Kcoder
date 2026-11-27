import { getRuntimeConfig, joinAppPath } from '@/config/runtime'
import { isContract } from '../../../shared/generated/validator.mjs'
import type { PeerSshEnrollmentV1, PeerSshPinReceiptV1 } from '../../../shared/generated/contracts.peer-ssh'
import type { PeerSshGatewayProposalV1, PeerSshGatewayStatusV1 } from '../../../shared/generated/contracts.peer-ssh-status'

export type PeerSshProposal = Omit<PeerSshGatewayProposalV1, 'receipt'> & { receipt?: PeerSshPinReceiptV1 }

export type PeerSshStatus = Omit<PeerSshGatewayStatusV1, 'proposals'> & { proposals: PeerSshProposal[] }

type PeerSshAction = 'status' | 'prepare' | 'apply' | 'reconcile' | 'revoke' | 'discard'

export class PeerSshEnrollmentError extends Error {
  readonly code: string
  readonly outcomeUnknown: boolean

  constructor(code: string, outcomeUnknown: boolean) {
    super(code)
    this.code = code
    this.outcomeUnknown = outcomeUnknown
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function proposal(value: unknown, targetId: string): value is PeerSshProposal {
  if (!isContract('PeerSshGatewayProposalV1', value) || !object(value) ||
      typeof value.proposalId !== 'string' || value.proposalId.length > 256 ||
      value.proposalId.length === 0 || typeof value.operationId !== 'string' ||
      value.operationId.length === 0 || value.operationId.length > 256 ||
      typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
      !['proposed', 'dispatching', 'setup_unconfirmed', 'completed', 'discarded'].includes(String(value.phase)) ||
      !['authorize', 'revoke'].includes(String(value.action)) ||
      !isContract('PeerSshEnrollmentV1', value.enrollment)) return false
  const enrollment = value.enrollment as PeerSshEnrollmentV1
  if (enrollment.version !== 1 || enrollment.target.targetId !== targetId) return false
  if (value.receipt === undefined) return value.phase !== 'completed'
  if (!isContract('PeerSshPinReceiptV1', value.receipt)) return false
  const receipt = value.receipt as PeerSshPinReceiptV1
  return value.phase === 'completed' && receipt.version === 1 &&
    receipt.operationId === value.operationId && receipt.enrollmentId === enrollment.enrollmentId &&
    receipt.status === (value.action === 'authorize' ? 'pinned' : 'revoked') &&
    receipt.generation === enrollment.generation + (value.action === 'revoke' ? 1 : 0)
}

function status(value: unknown, targetId: string): value is PeerSshStatus {
  return isContract('PeerSshGatewayStatusV1', value) && object(value) && typeof value.configured === 'boolean' &&
    ['none', 'pinned', 'revoked', 'revoking', 'setup_unconfirmed', 'scope_changed'].includes(String(value.pinStatus)) &&
    (!['pinned', 'revoked'].includes(String(value.pinStatus)) || value.configured) &&
    Array.isArray(value.proposals) && value.proposals.length <= 128 &&
    value.proposals.every(item => proposal(item, targetId))
}

/** Administrative actions are sent once; an ambiguous write is reconciled by
 * reading the original proposal and receipt, never by issuing another write. */
export async function peerSshEnrollmentRequest(
  action: PeerSshAction,
  targetId: string,
  workspacePath: string,
  original?: Pick<PeerSshProposal, 'proposalId' | 'digest'>,
  fetchImpl: typeof fetch = fetch
): Promise<PeerSshStatus | PeerSshProposal> {
  if ((action === 'apply' || action === 'reconcile' || action === 'discard') !== Boolean(original)) {
    throw new PeerSshEnrollmentError('PEER_SSH_ORIGINAL_PROPOSAL_REQUIRED', false)
  }
  const write = action !== 'status'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)
  try {
    let response: Response
    try {
      response = await fetchImpl(joinAppPath(getRuntimeConfig().appBasePath,
        `/api/servers/${encodeURIComponent(targetId)}/peer-ssh/${action}`), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath, ...(original
          ? { proposalId: original.proposalId, digest: original.digest } : {}) }), signal: controller.signal,
      })
    } catch {
      throw new PeerSshEnrollmentError('PEER_SSH_CONNECTION_UNAVAILABLE', write)
    }
    let result: unknown
    try { result = await response.json() } catch {
      throw new PeerSshEnrollmentError('PEER_SSH_INVALID_RESPONSE', write)
    }
    if (!response.ok) {
      const code = object(result) && typeof result.error === 'string' && /^PEER_SSH_[A-Z_]+$/.test(result.error)
        ? result.error : response.status === 404 ? 'PEER_SSH_UNSUPPORTED' : 'PEER_SSH_REQUEST_FAILED'
      const uncertain = object(result) && result.externalOutcome === 'unknown'
      throw new PeerSshEnrollmentError(code, uncertain || (write && response.status >= 500))
    }
    if (action === 'status' && status(result, targetId)) return result
    if (action !== 'status' && proposal(result, targetId)) {
      const originalMatches = !original ||
        (result.proposalId === original.proposalId && result.digest === original.digest)
      const actionMatches = action === 'prepare'
        ? result.action === 'authorize' && result.phase === 'proposed'
        : action === 'revoke'
          ? result.action === 'revoke' && result.phase === 'completed'
          : action === 'apply'
            ? result.action === 'authorize' && result.phase === 'completed'
            : action === 'discard'
              ? result.phase === 'discarded'
              : result.phase === 'completed' || result.phase === 'discarded'
      if (originalMatches && actionMatches) return result
    }
    throw new PeerSshEnrollmentError('PEER_SSH_INVALID_RESPONSE', write)
  } finally {
    clearTimeout(timeout)
  }
}
