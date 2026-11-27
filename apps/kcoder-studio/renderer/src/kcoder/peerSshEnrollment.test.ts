import { describe, expect, test, vi } from 'vitest'
import { PeerSshEnrollmentError, peerSshEnrollmentRequest } from './peerSshEnrollment'

const enrollment = {
  version: 1, purpose: 'kcoder.peer-message.ssh-enrollment.v1', enrollmentId: 'owned-pin', generation: 1,
  gateway: { gatewayId: 'owned-gateway', publicKey: Array(32).fill(7), keyGeneration: 1 },
  target: { targetId: 'owned-target', targetRevision: 'a'.repeat(64), accountGeneration: 'account-1',
    sshHostKey: 'ssh-ed25519 SHA256:fixture', sshUser: 'owned-peer' },
  native: { accountUid: 1001, profileIdentity: 'owned-profile', targetId: 'native-target',
    workspaceId: 'native-workspace', identityEpoch: 'epoch-1', publicKey: Array(32).fill(8) },
}
const pending = { proposalId: 'proposal-1', digest: 'b'.repeat(64), operationId: 'operation-1',
  phase: 'proposed', action: 'authorize', enrollment }
const completed = { ...pending, phase: 'completed', receipt: { version: 1, operationId: 'operation-1',
  enrollmentId: 'owned-pin', status: 'pinned', generation: 1, revision: 1 } }
const response = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value }) as Response

describe('peer SSH administration transport', () => {
  test('uses the selected target and workspace and requires explicit current pin status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ configured: false, pinStatus: 'none', proposals: [pending] }))
    await expect(peerSshEnrollmentRequest('status', 'owned-target', '/srv/project', undefined, fetchImpl))
      .resolves.toMatchObject({ pinStatus: 'none' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/api/servers/owned-target/peer-ssh/status')
    expect(JSON.parse(init.body)).toEqual({ workspacePath: '/srv/project' })
    expect(init.credentials).toBe('same-origin')

    fetchImpl.mockResolvedValue(response({ configured: true, proposals: [completed] }))
    await expect(peerSshEnrollmentRequest('status', 'owned-target', '/srv/project', undefined, fetchImpl))
      .rejects.toMatchObject({ code: 'PEER_SSH_INVALID_RESPONSE', outcomeUnknown: false })
    fetchImpl.mockResolvedValue(response({ configured: true, pinStatus: 'none', proposals: [{ ...pending, phase: 'discarded' }] }))
    await expect(peerSshEnrollmentRequest('status', 'owned-target', '/srv/project', undefined, fetchImpl))
      .resolves.toMatchObject({ configured: true, pinStatus: 'none' })
  })

  test('checks original proposal and receipt identity before accepting a write', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(completed))
    await expect(peerSshEnrollmentRequest('apply', 'owned-target', '/srv/project', pending, fetchImpl))
      .resolves.toMatchObject({ receipt: { operationId: 'operation-1' } })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ workspacePath: '/srv/project',
      proposalId: 'proposal-1', digest: 'b'.repeat(64) })
    fetchImpl.mockResolvedValue(response({ ...completed, receipt: { ...completed.receipt, operationId: 'another' } }))
    await expect(peerSshEnrollmentRequest('apply', 'owned-target', '/srv/project', pending, fetchImpl))
      .rejects.toMatchObject({ code: 'PEER_SSH_INVALID_RESPONSE', outcomeUnknown: true })
    fetchImpl.mockResolvedValue(response({ ...completed, proposalId: 'other-proposal' }))
    await expect(peerSshEnrollmentRequest('reconcile', 'owned-target', '/srv/project', pending, fetchImpl))
      .rejects.toMatchObject({ code: 'PEER_SSH_INVALID_RESPONSE', outcomeUnknown: true })
  })

  test('reports ambiguous writes without retrying and rejects missing original identity before dispatch', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection lost'))
    await expect(peerSshEnrollmentRequest('apply', 'owned-target', '/srv/project', pending, fetchImpl))
      .rejects.toMatchObject({ outcomeUnknown: true })
    expect(fetchImpl).toHaveBeenCalledOnce()
    await expect(peerSshEnrollmentRequest('apply', 'owned-target', '/srv/project', undefined, fetchImpl))
      .rejects.toBeInstanceOf(PeerSshEnrollmentError)
    expect(fetchImpl).toHaveBeenCalledOnce()
    await expect(peerSshEnrollmentRequest('prepare', 'owned-target', '/srv/project', undefined, fetchImpl))
      .rejects.toMatchObject({ outcomeUnknown: true })
  })

  test('discard and subsequent reconciliation retain the original proposal identity', async () => {
    const discarded = { ...pending, phase: 'discarded' }
    const fetchImpl = vi.fn().mockResolvedValue(response(discarded))
    await expect(peerSshEnrollmentRequest('discard', 'owned-target', '/srv/project', pending, fetchImpl))
      .resolves.toMatchObject({ proposalId: pending.proposalId, phase: 'discarded' })
    await expect(peerSshEnrollmentRequest('reconcile', 'owned-target', '/srv/project', pending, fetchImpl))
      .resolves.toMatchObject({ proposalId: pending.proposalId, phase: 'discarded' })
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { workspacePath: '/srv/project', proposalId: pending.proposalId, digest: pending.digest },
      { workspacePath: '/srv/project', proposalId: pending.proposalId, digest: pending.digest },
    ])
  })
})
