import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { KCoderAccountStartup } from '@/kcoder/KCoderAccountStartup'
import { fetchGatewayServersWithHealth } from '@/kcoder/gatewayRpc'
import { readRemoteCapabilities } from '@/kcoder/remotes/client'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { requestLocalExecutor } from '@/host/localExecutor'
import { NativeRemoteOperationWorkspace } from './NativeRemoteOperationWorkspace'
import { NativeRemoteOperationPanel } from './NativeRemoteOperationPanel'

vi.mock('@/kcoder/gatewayRpc', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kcoder/gatewayRpc')>()),
  fetchGatewayServersWithHealth: vi.fn(),
}))
vi.mock('@/kcoder/remotes/client', () => ({ readRemoteCapabilities: vi.fn() }))
vi.mock('@/host/localExecutor', async importOriginal => ({
  ...(await importOriginal<typeof import('@/host/localExecutor')>()),
  requestLocalExecutor: vi.fn(),
}))
vi.mock('./NativeRemoteOperationPanel', () => ({
  NativeRemoteOperationPanel: vi.fn(() => <div data-testid="selected-native-operation-panel" />),
}))

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
  vi.mocked(fetchGatewayServersWithHealth).mockResolvedValue([
    {
      id: 'owned-account',
      label: 'Owned account target',
      runtime: 'kcoder',
      transport: 'ssh',
      host: 'owned.invalid',
      status: 'unknown',
      user: 'fixture',
      security: { identity: { mode: 'kcoder-account', username: 'reader' } },
    },
  ])
})

it('renders the real account-startup settings without a Workbench and starts no native operation', async () => {
  render(<KCoderAccountStartup onChanged={vi.fn()} />)
  expect(await screen.findByTestId('kcoder-account-username')).toBeInTheDocument()
  expect(screen.getByTestId('kcoder-account-startup')).toBeInTheDocument()
  expect(
    screen.getByText(i18n.t('remoteCapabilities:operation.selectConversation'))
  ).toBeInTheDocument()
  expect(NativeRemoteOperationPanel).not.toHaveBeenCalled()
  expect(requestLocalExecutor).not.toHaveBeenCalled()
  expect(readRemoteCapabilities).not.toHaveBeenCalled()
})

it('uses the existing selected conversation target when a Workbench is present', async () => {
  const context = {
    state: {
      currentRuntimeTask: {
        deviceId: 'original-target',
        taskId: 1,
        workspacePath: '/owned-original-workspace',
      },
    },
  } as unknown as WorkbenchContextValue
  render(
    <WorkbenchContext.Provider value={context}>
      <NativeRemoteOperationWorkspace />
    </WorkbenchContext.Provider>
  )
  await screen.findByTestId('selected-native-operation-panel')
  await waitFor(() =>
    expect(NativeRemoteOperationPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { serverId: 'original-target', workspacePath: '/owned-original-workspace' },
      }),
      undefined
    )
  )
})

it('keeps operations unavailable when the selected conversation has no workspace', () => {
  const context = {
    state: { currentRuntimeTask: { deviceId: 'original-target', taskId: 1 } },
  } as unknown as WorkbenchContextValue
  render(
    <WorkbenchContext.Provider value={context}>
      <NativeRemoteOperationWorkspace />
    </WorkbenchContext.Provider>
  )
  expect(
    screen.getByText(i18n.t('remoteCapabilities:operation.selectConversation'))
  ).toBeInTheDocument()
  expect(NativeRemoteOperationPanel).not.toHaveBeenCalled()
  expect(requestLocalExecutor).not.toHaveBeenCalled()
})
