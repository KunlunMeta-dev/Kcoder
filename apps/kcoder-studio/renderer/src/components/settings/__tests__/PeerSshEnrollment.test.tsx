import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { PeerSshEnrollmentError, peerSshEnrollmentRequest, type PeerSshProposal } from '@/kcoder/peerSshEnrollment'
import { PeerSshEnrollment } from '../PeerSshEnrollment'

vi.mock('@/kcoder/peerSshEnrollment', async importOriginal => ({
  ...await importOriginal<typeof import('@/kcoder/peerSshEnrollment')>(),
  peerSshEnrollmentRequest: vi.fn(),
}))

const server: GatewayServer = { id: 'owned-target', label: '目标一', description: '', runtime: 'kcoder',
  transport: 'ssh', host: 'example.test', workspacePath: '/srv/project' }
const proposal: PeerSshProposal = { proposalId: 'original-proposal', digest: 'b'.repeat(64),
  operationId: 'original-operation', phase: 'proposed', action: 'authorize',
  enrollment: { version: 1, purpose: 'kcoder.peer-message.ssh-enrollment.v1', enrollmentId: 'owned-pin', generation: 1,
    gateway: { gatewayId: 'gateway', publicKey: Array(32).fill(1), keyGeneration: 1 },
    target: { targetId: 'owned-target', targetRevision: 'a'.repeat(64), accountGeneration: 'account',
      sshHostKey: 'ssh-ed25519 SHA256:fixture', sshUser: 'owned-peer' },
    native: { accountUid: 1001, profileIdentity: 'owned-profile', targetId: 'native-target',
      workspaceId: 'native-workspace', identityEpoch: 'epoch', publicKey: Array(32).fill(2) } } }
const completed: PeerSshProposal = { ...proposal, phase: 'completed', receipt: { version: 1,
  operationId: 'original-operation', enrollmentId: 'owned-pin', generation: 1, revision: 1, status: 'pinned' } }
const status = { configured: false, pinStatus: 'none' as const, proposals: [] }

describe('peer SSH authorization settings', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('zh-CN')
  })

  test('requires an explicit identity review before authorizing the original proposal', async () => {
    vi.mocked(peerSshEnrollmentRequest).mockResolvedValueOnce(status).mockResolvedValueOnce(proposal).mockResolvedValueOnce(completed)
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    expect(peerSshEnrollmentRequest).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('peer-ssh-read'))
    await user.click(await screen.findByTestId('peer-ssh-prepare'))
    expect(await screen.findByText('ssh-ed25519 SHA256:fixture')).toBeInTheDocument()
    expect(screen.getByText('owned-peer')).toBeInTheDocument()
    expect(screen.getByText('native-workspace')).toBeInTheDocument()
    expect(peerSshEnrollmentRequest).toHaveBeenCalledTimes(2)
    await user.click(screen.getByTestId('peer-ssh-apply'))
    expect(peerSshEnrollmentRequest).toHaveBeenLastCalledWith('apply', 'owned-target', '/srv/project',
      { proposalId: proposal.proposalId, digest: proposal.digest })
    expect(await screen.findByText('本次操作已记录。请重新读取当前状态。')).toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-apply')).not.toBeInTheDocument()
  })

  test('a lost write reconciles the original operation and never reapplies it', async () => {
    vi.mocked(peerSshEnrollmentRequest).mockResolvedValueOnce(status).mockResolvedValueOnce(proposal)
      .mockRejectedValueOnce(new PeerSshEnrollmentError('PEER_SSH_SETUP_UNCONFIRMED', true))
      .mockResolvedValueOnce({ configured: false, pinStatus: 'none', proposals: [{ ...proposal, phase: 'dispatching' }] })
      .mockResolvedValueOnce(completed)
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    await user.click(await screen.findByTestId('peer-ssh-prepare'))
    await user.click(await screen.findByTestId('peer-ssh-apply'))
    expect(await screen.findByText(/操作结果尚未确认/)).toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-apply')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('peer-ssh-read'))
    expect(await screen.findByTestId('peer-ssh-reconcile-original-proposal')).toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-prepare')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('peer-ssh-reconcile-original-proposal'))
    await waitFor(() => expect(peerSshEnrollmentRequest).toHaveBeenLastCalledWith('reconcile', 'owned-target', '/srv/project',
      { proposalId: proposal.proposalId, digest: proposal.digest }))
    expect(vi.mocked(peerSshEnrollmentRequest).mock.calls.filter(([action]) => action === 'apply')).toHaveLength(1)
  })

  test('canceling identity review preserves the original proposal for safe discard', async () => {
    vi.mocked(peerSshEnrollmentRequest).mockResolvedValueOnce(status).mockResolvedValueOnce(proposal)
      .mockResolvedValueOnce({ ...proposal, phase: 'discarded' })
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    await user.click(await screen.findByTestId('peer-ssh-prepare'))
    await user.click(await screen.findByTestId('peer-ssh-preview-cancel'))
    expect(screen.queryByTestId('peer-ssh-prepare')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('peer-ssh-discard-original-proposal'))
    expect(peerSshEnrollmentRequest).toHaveBeenLastCalledWith('discard', 'owned-target', '/srv/project',
      { proposalId: proposal.proposalId, digest: proposal.digest })
    expect(vi.mocked(peerSshEnrollmentRequest).mock.calls.filter(([action]) => action === 'apply')).toHaveLength(0)
  })

  test('revocation requires confirmation, and changing workspaces clears the observed state', async () => {
    vi.mocked(peerSshEnrollmentRequest).mockResolvedValueOnce({ configured: true, pinStatus: 'pinned', proposals: [completed] })
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    await user.click(await screen.findByTestId('peer-ssh-revoke'))
    expect(peerSshEnrollmentRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('peer-ssh-revoke-confirm')).toBeInTheDocument()
    await user.clear(screen.getByTestId('peer-ssh-workspace'))
    await user.type(screen.getByTestId('peer-ssh-workspace'), '/other')
    expect(screen.queryByTestId('peer-ssh-revoke-confirm')).not.toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-current-status')).not.toBeInTheDocument()
    expect(peerSshEnrollmentRequest).toHaveBeenCalledTimes(1)
  })

  test('submits a confirmed revocation once', async () => {
    const revoked: PeerSshProposal = { ...completed, action: 'revoke',
      receipt: { ...completed.receipt!, status: 'revoked', generation: 2 } }
    vi.mocked(peerSshEnrollmentRequest)
      .mockResolvedValueOnce({ configured: true, pinStatus: 'pinned', proposals: [completed] })
      .mockResolvedValueOnce(revoked)
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    await user.click(await screen.findByTestId('peer-ssh-revoke'))
    expect(peerSshEnrollmentRequest).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('peer-ssh-revoke-confirm'))
    expect(peerSshEnrollmentRequest).toHaveBeenLastCalledWith('revoke', 'owned-target', '/srv/project', undefined)
    expect(await screen.findByText('本次操作已记录。请重新读取当前状态。')).toBeInTheDocument()
    expect(peerSshEnrollmentRequest).toHaveBeenCalledTimes(2)
  })

  test('a proposed revocation may still be running and can only be checked by its original identity', async () => {
    const revoking: PeerSshProposal = { ...proposal, action: 'revoke' }
    vi.mocked(peerSshEnrollmentRequest).mockResolvedValueOnce({ configured: true, pinStatus: 'pinned', proposals: [revoking] })
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    expect(await screen.findByTestId('peer-ssh-reconcile-original-proposal')).toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-revoke')).not.toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-prepare')).not.toBeInTheDocument()
  })

  test('an old proposed authorization is not silently applied again after reload', async () => {
    vi.mocked(peerSshEnrollmentRequest).mockResolvedValueOnce({ ...status, proposals: [proposal] })
      .mockResolvedValueOnce({ ...proposal, phase: 'discarded' })
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    expect(await screen.findByTestId('peer-ssh-reconcile-original-proposal')).toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-apply')).not.toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-prepare')).not.toBeInTheDocument()
    expect(peerSshEnrollmentRequest).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('peer-ssh-discard-original-proposal'))
    expect(peerSshEnrollmentRequest).toHaveBeenLastCalledWith('discard', 'owned-target', '/srv/project',
      { proposalId: proposal.proposalId, digest: proposal.digest })
    expect(await screen.findByText('本次操作已记录。请重新读取当前状态。')).toBeInTheDocument()
  })

  test('a late status response cannot overwrite another target or workspace', async () => {
    let resolveRead!: (value: typeof status) => void
    vi.mocked(peerSshEnrollmentRequest).mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve }))
    const user = userEvent.setup()
    const view = render(<PeerSshEnrollment key="first" server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    view.rerender(<PeerSshEnrollment key="second" server={{ ...server, id: 'other', workspacePath: '/other' }} />)
    await user.click(screen.getByTestId('peer-ssh-open-other'))
    await act(async () => { resolveRead(status) })
    expect(screen.getByTestId('peer-ssh-workspace')).toHaveValue('/other')
    expect(screen.queryByTestId('peer-ssh-current-status')).not.toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-prepare')).not.toBeInTheDocument()
  })

  test('explains how to handle a changed remote identity without retrying the write', async () => {
    vi.mocked(peerSshEnrollmentRequest)
      .mockResolvedValueOnce({ configured: true, pinStatus: 'scope_changed', proposals: [] })
      .mockRejectedValueOnce(new PeerSshEnrollmentError('PEER_SSH_PIN_IDENTITY_CHANGED', false))
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    await user.click(await screen.findByTestId('peer-ssh-prepare'))
    expect(await screen.findByText('远端身份已变化。请先恢复原连接并撤销旧授权，再为新目标设置授权。')).toBeInTheDocument()
    expect(screen.queryByTestId('peer-ssh-prepare')).not.toBeInTheDocument()
    expect(peerSshEnrollmentRequest).toHaveBeenCalledTimes(2)
  })

  test('a changed remote revision offers the original undispatched operation for discard', async () => {
    vi.mocked(peerSshEnrollmentRequest).mockResolvedValueOnce(status).mockResolvedValueOnce(proposal)
      .mockRejectedValueOnce(new PeerSshEnrollmentError('PEER_SSH_PIN_NATIVE_REVISION_CHANGED', false))
      .mockResolvedValueOnce({ ...status, proposals: [proposal] })
    const user = userEvent.setup()
    render(<PeerSshEnrollment server={server} />)
    await user.click(screen.getByTestId('peer-ssh-open-owned-target'))
    await user.click(screen.getByTestId('peer-ssh-read'))
    await user.click(await screen.findByTestId('peer-ssh-prepare'))
    await user.click(await screen.findByTestId('peer-ssh-apply'))
    expect(await screen.findByText(/远端授权状态已变化/)).toBeInTheDocument()
    await user.click(screen.getByTestId('peer-ssh-read'))
    expect(await screen.findByTestId('peer-ssh-discard-original-proposal')).toBeInTheDocument()
    expect(vi.mocked(peerSshEnrollmentRequest).mock.calls.filter(([action]) => action === 'apply')).toHaveLength(1)
  })
})
