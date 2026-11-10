import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { readRemoteCapabilities } from '@/kcoder/remotes/client'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { RemoteCapabilityCatalog } from '../../../../shared/generated/contracts'
import { NativeRemoteCapabilityCatalog } from './NativeRemoteCapabilityCatalog'

vi.mock('@/kcoder/remotes/client', () => ({ readRemoteCapabilities: vi.fn() }))
const catalog: RemoteCapabilityCatalog = {
  snapshotId: 'original-snapshot',
  nextCursor: 'original-cursor',
  total: 11,
  observedAt: '2026-10-25T00:00:00.000Z',
  entries: [
    {
      id: 'original-entry',
      capability: 'officeWorkspaceV1',
      purpose: 'negotiated_native_capability',
      targetId: 'remote-original',
      transport: 'ssh',
      protocol: 'kcoder_app_server',
      protocolVersion: '2026-07-27',
      implementationVersion: '1.0.0',
      state: 'advertised',
      businessState: 'unknown',
      identityState: 'observed',
      nativeOwner: { accountId: 'original-owner', targetId: 'native-original', workspaceId: null },
      schemas: [],
      boundary: {
        resource: null,
        location: 'selected_native_target',
        authorization: 'revalidate_native_policy_per_request',
        allowedModels: 'not_observed',
        budget: 'not_reserved',
        tools: 'not_observed',
        confirmation: 'native_request_policy',
        inputTransfer: 'not_observed',
        resultTransfer: 'not_observed',
      },
      observedAt: '2026-10-25T00:00:00.000Z',
      reasonCode: 'REMOTE_CAPABILITY_ADVERTISED_NOT_BUSINESS_VERIFIED',
    },
  ],
}
let language: string
beforeEach(async () => {
  language = i18n.language
  await i18n.changeLanguage('en')
  vi.mocked(readRemoteCapabilities).mockReset()
})
afterEach(async () => {
  await i18n.changeLanguage(language)
})

describe('readonly remote capability directory', () => {
  test('opens without a network request; explicit refresh displays advertised and execution unknown separately', async () => {
    vi.mocked(readRemoteCapabilities).mockResolvedValue(structuredClone(catalog))
    render(<NativeRemoteCapabilityCatalog />)
    expect(readRemoteCapabilities).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observations' }))
    await screen.findByText('remote-original · officeWorkspaceV1')
    expect(screen.getByText('Advertised')).toBeInTheDocument()
    expect(
      screen.getByText('Native identity: Observed · Task execution: Unknown')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /execute|delegate|run task|start/i })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() =>
      expect(readRemoteCapabilities).toHaveBeenLastCalledWith(
        'original-cursor',
        expect.any(AbortSignal)
      )
    )
  })
  test('account invalidation aborts the exact pending reader and late observations cannot return', async () => {
    let complete!: (value: RemoteCapabilityCatalog) => void
    vi.mocked(readRemoteCapabilities).mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    render(<NativeRemoteCapabilityCatalog />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observations' }))
    const signal = vi.mocked(readRemoteCapabilities).mock.calls[0][1]
    act(() => notifyAccountContextChange('remote-original'))
    expect(signal.aborted).toBe(true)
    await act(async () => complete(structuredClone(catalog)))
    expect(screen.queryByText('remote-original · officeWorkspaceV1')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'The account, target, or connection changed. Read from the beginning for current observations.'
      )
    ).toBeInTheDocument()
  })
  test('a stale or foreign next page clears displayed facts and only offers a fresh readonly read', async () => {
    vi.mocked(readRemoteCapabilities)
      .mockResolvedValueOnce(structuredClone(catalog))
      .mockResolvedValueOnce({ ...structuredClone(catalog), snapshotId: 'foreign-snapshot' })
    render(<NativeRemoteCapabilityCatalog />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observations' }))
    await screen.findByText('remote-original · officeWorkspaceV1')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByRole('button', { name: 'Read from the beginning' })
    expect(screen.queryByText('remote-original · officeWorkspaceV1')).not.toBeInTheDocument()
    expect(readRemoteCapabilities).toHaveBeenCalledTimes(2)
  })
  test('Chinese unknown and unavailable labels remain visible, with unmount cancelling only this reader', async () => {
    await i18n.changeLanguage('zh-CN')
    vi.mocked(readRemoteCapabilities).mockRejectedValue(new Error('unavailable'))
    const view = render(<NativeRemoteCapabilityCatalog />)
    fireEvent.click(screen.getByRole('button', { name: '刷新观察记录' }))
    await screen.findByText('当前连接暂时无法读取目录，请检查 Gateway 后刷新。')
    const signal = vi.mocked(readRemoteCapabilities).mock.calls[0][1]
    view.unmount()
    expect(signal.aborted).toBe(true)
  })
})
