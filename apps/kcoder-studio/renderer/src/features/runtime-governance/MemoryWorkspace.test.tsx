const readySettings = {
  persisted: {
    memoryCenterEnabled: true,
    publicationsEnabled: true,
    businessAutomationEnabled: true,
  },
  effective: {
    memoryCenterEnabled: true,
    publicationsEnabled: true,
    businessAutomationEnabled: true,
  },
  connection: {
    memoryCenterEnabled: true,
    publicationsEnabled: true,
    businessAutomationEnabled: true,
  },
  revision: 'a'.repeat(64),
  restartRequired: false,
}
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: {
      currentRuntimeTask: { deviceId: 'local', taskId: 'task', workspacePath: '/workspace' },
      devices: [
        { device_id: 'local', name: 'Local', is_default: true },
        { device_id: 'other', name: 'Other' },
      ],
    },
  }),
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (serverId: string) => ({ key: serverId, isCurrent: fixture.current }),
}))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/knowledge-integration/MemoryCenter', () => ({
  MemoryCenter: ({ client }: { client: { scope: { accountId: string } } }) => (
    <div data-testid="bound-memory-owner">{client.scope.accountId}</div>
  ),
}))
import { MemoryWorkspace } from './MemoryWorkspace'

const scope = (account: string) => ({
  accountId: account,
  targetId: 'native-target',
  workspaceId: 'native-workspace',
  identityGeneration: 'generation',
  targetRevision: 'configuration',
})
afterEach(() => {
  cleanup()
  fixture.request.mockReset()
})

test('changing target discards a late previous owner and only binds native returned scope', async () => {
  let oldReply!: (value: unknown) => void
  fixture.request.mockImplementation((_method, params) =>
    params.method === 'settings/integrations/knowledge/read'
      ? Promise.resolve(readySettings)
      : params.serverId === 'local'
        ? new Promise(resolve => {
            oldReply = resolve
          })
        : Promise.resolve(scope('other-native-account'))
  )
  render(<MemoryWorkspace />)
  await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other' } })
  await screen.findByText('other-native-account')
  oldReply(scope('previous-native-account'))
  await waitFor(() => expect(screen.queryByText('previous-native-account')).not.toBeInTheDocument())
  expect(screen.getByTestId('bound-memory-owner')).toHaveTextContent('other-native-account')
  expect(
    fixture.request.mock.calls.every(call =>
      ['integrations/scope/read', 'settings/integrations/knowledge/read'].includes(call[1].method)
    )
  ).toBe(true)
})

test('unavailable scope exposes a safe retry and never renders raw diagnostic text', async () => {
  fixture.request
    .mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_PATH_AND_KEY'))
    .mockResolvedValueOnce(scope('native-account'))
    .mockResolvedValue(readySettings)
  render(<MemoryWorkspace />)
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('nativeUnavailable')
  expect(alert).not.toHaveTextContent('SYNTHETIC_PRIVATE_PATH_AND_KEY')
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await screen.findByText('native-account')
  expect(fixture.request).toHaveBeenCalledTimes(3)
})
