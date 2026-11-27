import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { CurrentInstallationRecoveryAction } from './CurrentInstallationRecoveryAction'
import { readCurrentInstallation, importCurrentInstallation, type CurrentInstallationPreview } from './startupCurrentInstallation'
vi.mock('./startupCurrentInstallation', () => ({ readCurrentInstallation: vi.fn(), importCurrentInstallation: vi.fn() }))
const preview: CurrentInstallationPreview = { token: 'owned-operation', sourceId: 'original', sourceLabel: '原连接',
  targetId: 'current-owned', command: 'C:\\Current Verified\\kcoder.exe', publicationState: 'ready' }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.mocked(readCurrentInstallation).mockResolvedValue(preview) })
afterEach(() => vi.restoreAllMocks())

test('one explicit action imports the proven program then selects its acknowledged target', async () => {
  vi.mocked(importCurrentInstallation).mockResolvedValue({ serverId: preview.targetId, sourcePreserved: true, originalServerId: 'original' })
  const selected = vi.fn(); render(<CurrentInstallationRecoveryAction sourceId="original" onSelected={selected} />)
  expect(importCurrentInstallation).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByTestId('startup-use-current-installation'))
  await waitFor(() => expect(selected).toHaveBeenCalledOnce())
  expect(importCurrentInstallation).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem('kcoder-studio:selected-server')).toBe('current-owned')
  expect(screen.getByText('使用此桌面包已验证的 KCoder 程序和当前账户的配置启动。原连接保留，可随时切回。')).toBeInTheDocument()
})

test('a lost result reads the same original operation instead of sending another import', async () => {
  vi.mocked(importCurrentInstallation).mockRejectedValue(new Error('owned unknown'))
  const selected = vi.fn(); render(<CurrentInstallationRecoveryAction sourceId="original" onSelected={selected} />)
  fireEvent.click(await screen.findByTestId('startup-use-current-installation'))
  await screen.findByTestId('startup-current-installation-reconcile')
  expect(screen.getByTestId('startup-use-current-installation')).toBeDisabled()
  vi.mocked(readCurrentInstallation).mockResolvedValue({ ...preview, publicationState: 'complete', receipt: { serverId: preview.targetId, sourcePreserved: true } })
  fireEvent.click(screen.getByTestId('startup-current-installation-reconcile'))
  await waitFor(() => expect(screen.getByTestId('startup-use-current-installation')).toBeEnabled())
  fireEvent.click(screen.getByTestId('startup-use-current-installation'))
  await waitFor(() => expect(selected).toHaveBeenCalledOnce())
  expect(importCurrentInstallation).toHaveBeenCalledTimes(1)
})

test('changing the original target discards a late acknowledgement without selecting another scope', async () => {
  let finish!: (value: { serverId: string; sourcePreserved: true }) => void
  vi.mocked(importCurrentInstallation).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const selected = vi.fn(); const view = render(<CurrentInstallationRecoveryAction sourceId="original" onSelected={selected} />)
  fireEvent.click(await screen.findByTestId('startup-use-current-installation'))
  await waitFor(() => expect(importCurrentInstallation).toHaveBeenCalledOnce())
  vi.mocked(readCurrentInstallation).mockResolvedValue(null)
  view.rerender(<CurrentInstallationRecoveryAction sourceId="new-source" onSelected={selected} />)
  finish({ serverId: preview.targetId, sourcePreserved: true })
  await waitFor(() => expect(readCurrentInstallation).toHaveBeenCalledWith('new-source', expect.any(AbortSignal)))
  expect(selected).not.toHaveBeenCalled(); expect(localStorage.getItem('kcoder-studio:selected-server')).toBeNull()
})
