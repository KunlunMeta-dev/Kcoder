import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { KCoderHooksSettingsPage } from './KCoderHooksSettingsPage'
import { fetchGatewayServers, type GatewayServer } from './gatewayRpc'
import { readHookConfiguration, updateHookConfiguration } from './hookConfigurationApi'
import type { HookConfiguration } from './gatewayHookConfiguration'
vi.mock('./gatewayRpc', () => ({ fetchGatewayServers: vi.fn() }))
vi.mock('./hookConfigurationApi', () => ({
  readHookConfiguration: vi.fn(),
  updateHookConfiguration: vi.fn(),
}))
const server = (id: string, principalId?: string): GatewayServer => ({
  id,
  label: id,
  runtime: 'kcoder',
  description: '',
  transport: 'local',
  ...(principalId
    ? {
        security: { identity: { mode: 'kcoder-account' as const } },
        accountIdentity: { principalId, username: principalId, role: 'user' as const },
      }
    : {}),
})
const result = (hooks: unknown, revision = 'r1'): HookConfiguration => ({
  hooks,
  revision,
  configurationPath: '/owned/settings.json',
  appliesToNewConversations: true,
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchGatewayServers).mockResolvedValue([server('alpha')])
  vi.mocked(readHookConfiguration).mockResolvedValue(result({}))
  vi.mocked(updateHookConfiguration).mockImplementation(async (_target, hooks) =>
    result(hooks, 'r2')
  )
})
test('adds a Hook without discarding other events, saves then explicitly clears only user Hooks', async () => {
  vi.mocked(readHookConfiguration).mockResolvedValue(result({ Stop: [] }))
  render(<KCoderHooksSettingsPage />)
  await screen.findByTestId('hooks-json')
  fireEvent.click(screen.getByTestId('hooks-example'))
  const draft = JSON.parse((screen.getByTestId('hooks-json') as HTMLTextAreaElement).value)
  expect(draft.Stop).toEqual([])
  expect(draft.UserPromptSubmit).toHaveLength(1)
  fireEvent.click(screen.getByTestId('hooks-save'))
  await waitFor(() =>
    expect(updateHookConfiguration).toHaveBeenCalledWith(server('alpha'), draft, 'r1')
  )
  await waitFor(() => expect(screen.getByTestId('hooks-save')).toBeDisabled())
  fireEvent.click(screen.getByTestId('hooks-clear'))
  fireEvent.click(screen.getByTestId('hooks-confirm-close'))
  expect(updateHookConfiguration).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('hooks-clear'))
  fireEvent.click(screen.getByTestId('hooks-confirm-confirm'))
  await waitFor(() =>
    expect(updateHookConfiguration).toHaveBeenLastCalledWith(server('alpha'), {}, 'r2')
  )
})
test('invalid JSON does not dispatch; a conflict keeps the draft for recovery', async () => {
  render(<KCoderHooksSettingsPage />)
  await screen.findByTestId('hooks-json')
  fireEvent.change(screen.getByTestId('hooks-json'), { target: { value: '{invalid' } })
  fireEvent.click(screen.getByTestId('hooks-save'))
  expect(updateHookConfiguration).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBeInTheDocument()
  const draft = '{"Stop":[]}'
  vi.mocked(updateHookConfiguration).mockRejectedValue({ data: { kind: 'hook_config_conflict' } })
  fireEvent.change(screen.getByTestId('hooks-json'), { target: { value: draft } })
  fireEvent.click(screen.getByTestId('hooks-save'))
  await waitFor(() => expect(screen.getByTestId('hooks-json')).not.toBeDisabled())
  expect(screen.getByTestId('hooks-json')).toHaveValue(draft)
  fireEvent.click(screen.getByTestId('hooks-refresh'))
  fireEvent.click(screen.getByTestId('hooks-confirm-close'))
  expect(screen.getByTestId('hooks-json')).toHaveValue(draft)
})
test('account changes clear old drafts immediately and ignore late save completion', async () => {
  const alice = server('same', 'alice'),
    bob = server('same', 'bob')
  vi.mocked(fetchGatewayServers).mockResolvedValueOnce([alice]).mockResolvedValueOnce([bob])
  vi.mocked(readHookConfiguration)
    .mockResolvedValueOnce(result({}))
    .mockResolvedValueOnce(result({ Stop: [] }, 'bob-revision'))
  let finish!: (value: HookConfiguration) => void
  vi.mocked(updateHookConfiguration).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  render(<KCoderHooksSettingsPage />)
  await screen.findByTestId('hooks-json')
  fireEvent.change(screen.getByTestId('hooks-json'), {
    target: { value: '{"UserPromptSubmit":[]}' },
  })
  fireEvent.click(screen.getByTestId('hooks-save'))
  await waitFor(() => expect(updateHookConfiguration).toHaveBeenCalledTimes(1))
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  expect(screen.queryByTestId('hooks-json')).not.toBeInTheDocument()
  await screen.findByTestId('hooks-json')
  expect(screen.getByTestId('hooks-identity')).toHaveTextContent('bob')
  await act(async () => finish(result({ UserPromptSubmit: [] }, 'alice-late')))
  expect(JSON.parse((screen.getByTestId('hooks-json') as HTMLTextAreaElement).value)).toEqual({
    Stop: [],
  })
  expect(screen.getByTestId('hooks-save')).toBeDisabled()
})
