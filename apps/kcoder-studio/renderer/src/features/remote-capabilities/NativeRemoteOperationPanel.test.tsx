import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { NativeRemoteOperationPanel } from './NativeRemoteOperationPanel'
import { RemoteOperationClientError } from '@/kcoder/remotes/operationClient'
import type { RemoteOperationControlReply, RemoteOperationSnapshot } from '../../../../shared/generated/contracts.integrations-remotes'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/accountContextEvents', () => ({ listenAccountContextChanges: () => () => {}, captureAccountContextRevision: () => () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const scope = { accountId: 'a', targetId: 't', workspaceId: 'w', identityGeneration: 'g', targetRevision: 'r' }
const original: RemoteOperationSnapshot = { operationId: 'original', operationRevision: 3, operationPhase: 'executing', journalRevision: 5,
  receiver: { status: 'unknown', terminalConfirmed: false, reasonCode: 'REMOTE_RECEIVER_NATIVE_FACT_UNAVAILABLE' }, cleanup: 'unconfirmed', protocol: [{ stage: 'prompt', status: 'unknown' }], businessCompleted: false }
const reply = (snapshot: RemoteOperationSnapshot | null): RemoteOperationControlReply => ({ requestId: 'read', scope, operationId: 'original', outcome: 'observed', snapshot })
const target = { serverId: 'local', workspacePath: '/owned' }
const fill = () => fireEvent.change(screen.getByTestId('remote-operation-id'), { target: { value: 'original' } })
describe('original remote operation UI', () => {
  test('unknown cancellation never repeats and requires an explicit original read', async () => {
    const client = { read: vi.fn(async () => reply(original)), cancel: vi.fn(async () => { throw new RemoteOperationClientError('REMOTE_CONTROL_UNAVAILABLE', true) }), recent: vi.fn(async () => ({ requestId: 'recent', scope, items: [{ operationId: 'original', journalRevision: 5, receiverObserved: true }], total: 1 })), dispose: vi.fn() }
    render(<NativeRemoteOperationPanel target={target} createClient={() => client} />)
    expect(client.read).not.toHaveBeenCalled()
    fill(); fireEvent.click(screen.getByText('operation.read'))
    await screen.findByTestId('remote-operation-observation')
    expect(screen.getByText('operation.status.unknown')).toBeVisible()
    expect(screen.getByText('operation.businessPartial')).toBeVisible()
    fireEvent.click(screen.getByText('operation.cancel'))
    fireEvent.click(screen.getByText('operation.confirmCancel'))
    await screen.findByText('operation.unknownCancellation')
    expect(client.cancel).toHaveBeenCalledTimes(1)
    expect(client.cancel).toHaveBeenCalledWith('original', 3)
    expect(screen.getByText('operation.cancel')).toBeDisabled()
    fireEvent.click(screen.getByText('operation.read'))
    await waitFor(() => expect(client.read).toHaveBeenCalledTimes(2))
    expect(client.cancel).toHaveBeenCalledTimes(1)
  })
  test('explicit recent read selects the exact original instead of creating or guessing a task', async () => {
    const client = { read: vi.fn(async () => reply(original)), recent: vi.fn(async () => ({ requestId: 'recent', scope, items: [{ operationId: 'original', journalRevision: 5, receiverObserved: true }], total: 1 })), cancel: vi.fn(), dispose: vi.fn() }
    render(<NativeRemoteOperationPanel target={target} createClient={() => client} />)
    expect(client.recent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('operation.recent'))
    await screen.findByTestId('remote-operation-recent')
    fireEvent.click(screen.getByText('original'))
    await screen.findByTestId('remote-operation-observation')
    expect(client.read).toHaveBeenCalledWith('original')
    expect(client.cancel).not.toHaveBeenCalled()
  })
  test('native completed and business verification remain separate, without another cancel', async () => {
    const client = { read: vi.fn(async () => reply({ ...original, receiver: { status: 'completed', terminalConfirmed: true, identity: { threadId: 'original-receiver', turnId: 'turn', attemptId: 'attempt' }, finishedAtMs: 1000 }, cleanup: 'confirmed' })), cancel: vi.fn(), recent: vi.fn(async () => ({ requestId: 'recent', scope, items: [{ operationId: 'original', journalRevision: 5, receiverObserved: true }], total: 1 })), dispose: vi.fn() }
    render(<NativeRemoteOperationPanel target={target} createClient={() => client} />)
    fill(); fireEvent.click(screen.getByText('operation.read'))
    await screen.findByText('operation.status.completed')
    expect(screen.getByText('operation.businessPartial')).toBeVisible()
    expect(screen.getByText('operation.cancel')).toBeDisabled()
    expect(client.cancel).not.toHaveBeenCalled()
  })
  test('a late result from another target cannot restore its observation', async () => {
    let complete!: (value: RemoteOperationControlReply) => void
    const client = { read: vi.fn(() => new Promise<RemoteOperationControlReply>(resolve => { complete = resolve })), cancel: vi.fn(), recent: vi.fn(async () => ({ requestId: 'recent', scope, items: [{ operationId: 'original', journalRevision: 5, receiverObserved: true }], total: 1 })), dispose: vi.fn() }
    const view = render(<NativeRemoteOperationPanel target={target} createClient={() => client} />)
    fill(); fireEvent.click(screen.getByText('operation.read'))
    await waitFor(() => expect(complete).toBeTypeOf('function'))
    view.rerender(<NativeRemoteOperationPanel target={{ serverId: 'another', workspacePath: '/another' }} createClient={() => client} />)
    await act(async () => complete(reply(original)))
    expect(screen.queryByTestId('remote-operation-observation')).toBeNull()
    expect(screen.getByTestId('remote-operation-id')).toHaveValue('')
  })
})
