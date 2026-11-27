import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SessionMessagesControl } from './SessionMessagesControl'
import '@/i18n'

const bridge = vi.hoisted(() => ({ request: vi.fn(), servers: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: bridge.request }))
vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: bridge.servers }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({ openRuntimeTask: vi.fn() }) }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('closed session-message controls do not read the directory, while reopening reads current authority', async () => {
  const target = { id: 'panel-scope-target', transport: 'local', command: 'kcoder' }
  bridge.servers.mockResolvedValue([target])
  bridge.request.mockImplementation(async (_command, input) => {
    if (input.operation === 'supports') return { scope: 'owned-panel', sourceThreadId: 'source', discovery: false, messages: false }
    throw new Error('No mutation or discovery is authorized by this fixture')
  })
  render(<SessionMessagesControl address={{ deviceId: target.id, taskId: 'source', threadId: 'source', workspacePath: '/owned-panel' }} />)
  const changed = async () => act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
    await Promise.resolve()
  })
  await changed()
  expect(bridge.servers).not.toHaveBeenCalled()
  expect(bridge.request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('session-messages-open'))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(1))
  expect(bridge.servers).toHaveBeenCalledTimes(1)
  await changed()
  expect(bridge.servers).toHaveBeenCalledTimes(2)
  expect(bridge.request).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByTestId('session-messages-dialog')).not.toBeInTheDocument())
  for (let index = 0; index < 4; index++) await changed()
  expect(bridge.servers).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByTestId('session-messages-open'))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2))
  expect(bridge.servers).toHaveBeenCalledTimes(3)
})
